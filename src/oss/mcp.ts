import {createRequire} from 'node:module'
import type {DatabaseSync as Database} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import type {McpAuthorization} from './mcp-authorization.js'
import {chmod,open} from 'node:fs/promises'
import {join} from 'node:path'
import {McpConnectionError,type McpConnectionConfig,type McpConnectionDraft,type McpConnectionRecord,type McpSecretReference} from './mcp-types.js'

const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
function sorted(value:any):any { return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,sorted(value[key])])):value }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
const text=(value:unknown,name:string,max:number,empty=false):string=>{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max||value.includes('\0'))throw new McpConnectionError(400,`Invalid MCP ${name}`);return value}
const identity=(value:unknown)=>{const id=text(value,'identity',150);if(!/^[A-Za-z0-9_-]+$/.test(id))throw new McpConnectionError(400,'Invalid MCP identity');return id}
const cursor=(value:number)=>{if(!Number.isSafeInteger(value)||value<1)throw new McpConnectionError(400,'Invalid MCP cursor');return value}
const fingerprint=(record:McpConnectionRecord)=>{const {digest,...body}=record;return hash(body)}
function references(value:unknown,headers:boolean):Record<string,McpSecretReference> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>30)throw new McpConnectionError(400,'Use at most 30 explicit Host environment references')
  const seen=new Set<string>()
  return Object.fromEntries(Object.entries(value).map(([key,raw])=>{
    if(!(headers?/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/:/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).test(key))throw new McpConnectionError(400,'Invalid MCP credential target name')
    const normalized=headers?key.toLowerCase():key
    if(seen.has(normalized))throw new McpConnectionError(400,'Duplicate MCP header name');seen.add(normalized)
    if(headers&&['host','connection','content-length','transfer-encoding','cookie','set-cookie','origin','referer'].includes(normalized))throw new McpConnectionError(400,'Reserved MCP HTTP header')
    if(!headers&&(/^(NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PATH|HOME|USERPROFILE|SHELL|COMSPEC)$/i.test(key)))throw new McpConnectionError(400,'Interpreter/loader environment overrides are not credential bindings')
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['environment','prefix'].includes(key)))throw new McpConnectionError(400,'Credentials require an environment reference, never a plaintext value')
    const ref=raw as McpSecretReference;const environment=text(ref.environment,'Host environment name',100)
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environment))throw new McpConnectionError(400,'Invalid Host environment name')
    const prefix=ref.prefix===undefined?undefined:text(ref.prefix,'credential prefix',40,true)
    if(prefix!==undefined&&!['','Bearer ','Basic ','Token '].includes(prefix))throw new McpConnectionError(400,'Use an empty or standard authentication prefix')
    return [key,{environment,...(prefix!==undefined?{prefix}:{})}]
  }))
}
export function normalizeMcpConfig(input:McpConnectionConfig):McpConnectionConfig {
  if(!input||typeof input!=='object')throw new McpConnectionError(400,'MCP connection configuration required')
  const serverName=text(input.serverName,'server namespace',32)
  if(!/^[A-Za-z0-9_-]+$/.test(serverName)||serverName.includes('__')||serverName.endsWith('_'))throw new McpConnectionError(400,'MCP namespace uses 1–32 letters/digits/_/- without double or trailing underscores, to keep tool ownership unambiguous')
  const toolCallTimeoutMs=input.toolCallTimeoutMs
  if(!Number.isSafeInteger(toolCallTimeoutMs)||toolCallTimeoutMs<1000||toolCallTimeoutMs>300000)throw new McpConnectionError(400,'MCP tool timeout must be 1000–300000 ms')
  if(input.transport==='stdio'){
    if(!Array.isArray(input.args)||input.args.length>100)throw new McpConnectionError(400,'Use at most 100 MCP process arguments')
    const args=input.args.map(arg=>text(arg,'process argument',2000,true));const command=text(input.command,'executable',2000)
    if(command!==command.trim()||/[\r\n]/.test(command))throw new McpConnectionError(400,'Use an executable, without a shell command wrapper')
    const config={transport:'stdio' as const,serverName,command,args,env:references(input.env,false),toolCallTimeoutMs}
    if(Buffer.byteLength(JSON.stringify(config))>32000)throw new McpConnectionError(413,'MCP configuration exceeds 32 KB')
    return config
  }
  if(input.transport==='streamable-http'){
    let url:URL;try{url=new URL(text(input.url,'endpoint URL',2000))}catch{throw new McpConnectionError(400,'MCP endpoint URL required')}
    if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new McpConnectionError(400,'Use credential-free HTTPS, or explicit loopback HTTP, without query/fragment; bind authentication through Host environment references')
    return {transport:'streamable-http',serverName,url:url.href,headers:references(input.headers,true),toolCallTimeoutMs}
  }
  throw new McpConnectionError(400,'Use Harness stdio or streamable-http transport')
}

/** Project-owned configuration only. Opening or editing never invokes an MCP server. */
export class ProjectMcpConnections {
  private writes:Promise<unknown>=Promise.resolve();private closing=false;private disposing?:Promise<void>
  private constructor(private db:Database,private workspace:string,private authority:McpAuthorization){}
  static async open(workspace:string,authority:McpAuthorization):Promise<ProjectMcpConnections>{
    const path=join(workspace,'.omicos-oss','mcp.sqlite');const file=await open(path,'a',0o600);await file.close();await chmod(path,0o600);const db=new DatabaseSync(path)
    try{const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),application=Number(db.prepare('PRAGMA application_id').get()!.application_id);if(version>1||(application!==0&&application!==0x4f4d4350)||(version&&application!==0x4f4d4350))throw new Error('Unsupported MCP registry; preserve its database');db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');if(!version){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw new Error('Unknown MCP registry database');db.exec(`BEGIN IMMEDIATE; CREATE TABLE connections(id TEXT PRIMARY KEY,server_name TEXT UNIQUE NOT NULL,record_json TEXT NOT NULL); CREATE TABLE revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,revision)); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,connection_id TEXT NOT NULL); PRAGMA application_id=${0x4f4d4350}; PRAGMA user_version=1; COMMIT;`)}return new ProjectMcpConnections(db,workspace,authority)}catch(error){db.close();throw error}
  }
  private serial<T>(task:()=>T):Promise<T>{if(this.closing)return Promise.reject(new McpConnectionError(409,'MCP registry is closing'));const result=this.writes.then(task);this.writes=result.catch(()=>{});return result}
  get(id:string,revision?:number):McpConnectionRecord{identity(id);if(revision!==undefined)cursor(revision);const row=revision===undefined?this.db.prepare('SELECT record_json FROM connections WHERE id=?').get(id):this.db.prepare('SELECT record_json FROM revisions WHERE id=? AND revision=?').get(id,revision);if(!row)throw new McpConnectionError(404,'MCP connection/revision not found');const record=JSON.parse(String(row.record_json)) as McpConnectionRecord;if(record.id!==id||(revision!==undefined&&record.revision!==revision)||fingerprint(record)!==record.digest)throw new McpConnectionError(409,'MCP record identity changed; preserve and inspect the database');return record}
  list(){return {connections:this.db.prepare('SELECT id FROM connections ORDER BY rowid DESC').all().map(row=>this.get(String(row.id)))}}
  history(id:string,before=Number.MAX_SAFE_INTEGER){this.get(id);cursor(before);const rows=this.db.prepare('SELECT revision FROM revisions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51').all(id,before);return {revisions:rows.slice(0,50).map(row=>{const record=this.get(id,Number(row.revision));const {revision,title,enabled,updatedAt,note,digest}=record;return {id,revision,title,enabled,updatedAt,note,digest}}),next:rows.length>50?Number(rows[49].revision):undefined}}
  private replay(operation:string,request:unknown){identity(operation);const row=this.db.prepare('SELECT request_hash,connection_id FROM operations WHERE id=?').get(operation);if(!row)return;if(row.request_hash!==hash(request))throw new McpConnectionError(409,'MCP operation belongs to another request/actor');return this.get(String(row.connection_id))}
  authorized(record:McpConnectionRecord){return record.enabled&&this.authority.authorized(this.workspace,record.id,record.digest)}
  private commit(record:McpConnectionRecord,operation:string,request:unknown){
    record.digest=fingerprint(record)
    // Revoke first, commit the project record second, grant last. A failure or
    // crash between databases leaves access closed; a retry never re-grants.
    this.authority.revoke(this.workspace,record.id)
    this.db.exec('BEGIN IMMEDIATE')
    try{this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(record.id,record.revision,JSON.stringify(record));this.db.prepare('INSERT INTO connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET server_name=excluded.server_name,record_json=excluded.record_json').run(record.id,record.config.serverName,JSON.stringify(record));this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operation,hash(request),record.id);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
    if(record.enabled)this.authority.grant(this.workspace,record.id,record.digest)
    return record
  }
  save(input:McpConnectionDraft):Promise<McpConnectionRecord>{return this.serial(()=>{
    if(!input||typeof input!=='object')throw new McpConnectionError(400,'MCP connection draft required');const request={action:'save',input,actor:'user:workbench'};const replay=this.replay(input.operationId,request);if(replay)return replay
    if(input.id===undefined&&input.revision!==undefined)throw new McpConnectionError(400,'Connection ID required with revision');const old=input.id===undefined?undefined:this.get(input.id);if(old&&old.revision!==input.revision)throw new McpConnectionError(409,'MCP connection changed; reload before editing')
    const config=normalizeMcpConfig(input.config);const duplicate=this.db.prepare('SELECT id FROM connections WHERE server_name=?').get(config.serverName);if(duplicate&&duplicate.id!==old?.id)throw new McpConnectionError(409,'MCP namespace already belongs to another connection in this project')
    if(!old&&Number(this.db.prepare('SELECT count(*) AS count FROM connections').get()!.count)>=50)throw new McpConnectionError(409,'Project MCP registry is limited to 50 connections')
    const at=new Date().toISOString();return this.commit({id:old?.id||randomUUID(),revision:(old?.revision||0)+1,title:text(input.title,'title',200),config,enabled:false,createdAt:old?.createdAt||at,updatedAt:at,note:text(input.note,'change note',4000),digest:''},input.operationId,request)
  })}
  setEnabled(input:{id:string;revision:number;operationId:string;enabled:boolean;note:string}):Promise<McpConnectionRecord>{return this.serial(()=>{
    if(!input||typeof input!=='object'||typeof input.enabled!=='boolean')throw new McpConnectionError(400,'Explicit MCP enable/disable decision required');const request={action:'enabled',input,actor:'user:workbench'};const replay=this.replay(input.operationId,request);if(replay)return replay
    const record=this.get(input.id);if(record.revision!==input.revision)throw new McpConnectionError(409,'MCP connection changed; reread before deciding');if(record.enabled===input.enabled&&(!input.enabled||this.authorized(record)))throw new McpConnectionError(409,'MCP connection already has this state');if(input.enabled&&Number(this.db.prepare("SELECT count(*) AS count FROM connections WHERE json_extract(record_json,'$.enabled')=1 AND id<>?").get(record.id)!.count)>=10)throw new McpConnectionError(409,'Enable at most 10 MCP servers per project')
    record.enabled=input.enabled;record.revision++;record.updatedAt=new Date().toISOString();record.note=text(input.note,'human decision note',4000);return this.commit(record,input.operationId,request)
  })}
  export(id:string,revision?:number){const record=this.get(id,revision);return {schema:'omicos.mcp/1',connection:{title:record.title,config:record.config},origin:{id:record.id,revision:record.revision,digest:record.digest},enabled:false,scope:'Configuration and environment-reference names only; no credential values or transferable enablement. Commands/arguments/endpoint paths are not automatically redacted.'}}
  reconnect(input:{id:string;revision:number;operationId:string;note:string}):Promise<McpConnectionRecord>{return this.serial(()=>{
    if(!input||typeof input!=='object')throw new McpConnectionError(400,'Explicit MCP reconnect decision required');const request={action:'reconnect',input,actor:'user:workbench'};const replay=this.replay(input.operationId,request);if(replay)return replay
    const record=this.get(input.id);if(record.revision!==input.revision||!this.authorized(record))throw new McpConnectionError(409,'Reconnect requires the current Host-authorized enabled connection revision')
    record.revision++;record.updatedAt=new Date().toISOString();record.note=text(input.note,'reconnect note',4000);return this.commit(record,input.operationId,request)
  })}
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.closing=true;return this.disposing=this.writes.then(()=>this.db.close())}
}
