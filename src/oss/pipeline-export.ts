import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {lstat} from 'node:fs/promises'
import {setImmediate} from 'node:timers/promises'
import {PipelineError} from './pipeline-types.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
let active=0
export interface PipelineExport{runId:string;revision:number;bytes:number;sha256:string;signal:AbortSignal;chunks():AsyncIterable<Uint8Array>;dispose():void}
/** One WAL snapshot, two bounded passes: digest/length first, then HTTP download. */
export async function openPipelineExport(file:string,identity:{dev:number;ino:number},id:string,revision:number,caller:AbortSignal,validateDefinition:(value:unknown)=>string,onClose:()=>void):Promise<PipelineExport>{
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||!Number.isSafeInteger(revision)||revision<1)throw new PipelineError(400,'A valid run ID and exact revision are required for export')
 if(active>=2)throw new PipelineError(429,'Two Pipeline export snapshots are already open; finish or close a download')
 active++;const own=new AbortController(),signal=AbortSignal.any([caller,own.signal,AbortSignal.timeout(600000)]);let db:InstanceType<typeof DatabaseSync>|undefined,closed=false
 const dispose=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',dispose);own.abort();try{if(db){try{db.exec('ROLLBACK')}catch{}try{db.close()}catch{}}}finally{active--;onClose()}}
 const check=()=>{signal.throwIfAborted();if(closed)throw new PipelineError(409,'Pipeline export snapshot is closed')}
 try{
  check();const status=await lstat(file);check();if(!status.isFile()||status.dev!==identity.dev||status.ino!==identity.ino)throw new PipelineError(409,'Pipeline database identity changed; preserve and inspect it')
  db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');signal.addEventListener('abort',dispose,{once:true});check()
  if(Number(db.prepare('PRAGMA application_id').get()!.application_id)!==0x4f50534c||Number(db.prepare('PRAGMA user_version').get()!.user_version)!==1)throw new PipelineError(409,'Unsupported Pipeline export database')
  const row=db.prepare("SELECT json_extract(record_json,'$.id') AS id,json_extract(record_json,'$.revision') AS revision,json_extract(record_json,'$.definitionId') AS definition_id FROM runs WHERE id=?").get(id)
  if(!row)throw new PipelineError(404,'Pipeline run not found');if(row.id!==id||row.revision!==revision)throw new PipelineError(409,'Pipeline changed; refresh before exporting its exact revision')
  const definitionId=String(row.definition_id),definition=db.prepare('SELECT document_json FROM definitions WHERE id=? AND length(CAST(document_json AS BLOB))<=2000000').get(definitionId)
  if(!definition||validateDefinition(JSON.parse(String(definition.document_json)))!==definitionId)throw new PipelineError(409,'Pinned Pipeline definition is missing or changed')
  const prefix=Buffer.from(JSON.stringify({schema:'omicos.pipeline-run/1',scope:'Persisted definition, run metadata and event journal only; external dataset/artifact files and separate full execution receipts are not collected.',runId:id,revision,exportedAt:new Date().toISOString()}).slice(0,-1)+',"definition":')
  async function* field(table:'definitions'|'runs'|'events',column:'document_json'|'record_json'|'data_json',key:string|number):AsyncGenerator<Uint8Array>{
   const keyColumn=table==='events'?'seq':'id';const row=db!.prepare(`SELECT length(CAST(${column} AS BLOB)) AS bytes,json_valid(${column}) AS valid FROM ${table} WHERE ${keyColumn}=?`).get(key);if(!row||row.valid!==1)throw new PipelineError(409,'Persisted Pipeline JSON is missing or malformed; preserve and inspect the database');const size=Number(row.bytes)
   for(let offset=1;offset<=size;offset+=65536){check();const chunk=db!.prepare(`SELECT substr(CAST(${column} AS BLOB),?,65536) AS chunk FROM ${table} WHERE ${keyColumn}=?`).get(offset,key)!.chunk as Uint8Array;yield chunk;await setImmediate(undefined,{signal})}
  }
  async function* body():AsyncGenerator<Uint8Array>{
   check();yield prefix;yield* field('definitions','document_json',definitionId);yield Buffer.from(',"run":');yield* field('runs','record_json',id);yield Buffer.from(',"events":[')
   let after=0,first=true
   for(;;){check();const rows=db!.prepare('SELECT seq,type,at FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 100').all(id,after);if(!rows.length)break
    for(const event of rows){check();yield Buffer.from((first?'':',')+JSON.stringify({seq:Number(event.seq),runId:id,type:String(event.type),at:String(event.at)}).slice(0,-1)+',"data":');yield* field('events','data_json',Number(event.seq));yield Buffer.from('}');first=false;after=Number(event.seq)}
   }
   yield Buffer.from(']}\n')
  }
  const hash=createHash('sha256');let bytes=0;for await(const chunk of body()){check();bytes+=chunk.byteLength;if(!Number.isSafeInteger(bytes))throw new PipelineError(413,'Pipeline export length exceeds safe integer range');hash.update(chunk)}check();let consumed=false
  return {runId:id,revision,bytes,sha256:hash.digest('hex'),signal,chunks(){if(consumed)throw new PipelineError(409,'Pipeline export stream can only be consumed once');consumed=true;const iterator=(async function*(){try{yield* body()}finally{dispose()}})();const close=iterator.return.bind(iterator);iterator.return=async value=>{dispose();return close(value)};return iterator},dispose}
 }catch(error){dispose();throw error}
}
