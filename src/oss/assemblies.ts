import {createRequire} from 'node:module'
import type {DatabaseSync as Database} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {chmod,open} from 'node:fs/promises'
import {join} from 'node:path'
import type {FigureStudio} from './figures.js'
import {AssemblyError,type AssemblyDraft,type AssemblyLayout,type AssemblyVersion} from './assembly-types.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
function sort(value:any):any{return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,sort(value[key])])):value}
const canonical=(value:unknown)=>JSON.stringify(sort(value));const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const fingerprint=(value:AssemblyVersion)=>{const {digest,...body}=value;return hash(canonical(body))}
const text=(value:unknown,name:string,max:number,empty=false):string=>{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value))throw new AssemblyError(400,`Invalid assembly ${name}`);return value}
const identity=(value:unknown)=>{const id=text(value,'identity',150);if(!/^[A-Za-z0-9_-]+$/.test(id))throw new AssemblyError(400,'Invalid assembly identity');return id}
const integer=(value:number,name:string,min:number,max:number)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new AssemblyError(400,`Invalid assembly ${name}`);return value}
const key=(id:string,revision:number)=>`${id}:${revision}`
export function assemblyLayout(value:AssemblyLayout):AssemblyLayout{
  if(!value||typeof value!=='object'||!Array.isArray(value.panels)||!value.panels.length||value.panels.length>16)throw new AssemblyError(400,'Choose 1–16 explicit figure panels')
  const width=integer(value.width,'page width',200,8000),height=integer(value.height,'page height',200,8000)
  if(width*height>32000000)throw new AssemblyError(400,'Assembly page exceeds 32 million pixels')
  const labels=new Set<string>()
  const panels=value.panels.map(panel=>{
    if(!panel||typeof panel!=='object')throw new AssemblyError(400,'Panel layout required')
    const x=integer(panel.x,'panel x',0,width),y=integer(panel.y,'panel y',0,height),w=integer(panel.width,'panel width',80,width),h=integer(panel.height,'panel height',80,height),label=text(panel.label,'literal panel label',40,true)
    if(x+w>width||y+h>height||/[\r\n\t]/.test(label))throw new AssemblyError(400,'Panel rectangle must fit its page; labels must be single-line')
    if(label&&labels.has(label))throw new AssemblyError(400,'Use distinct nonempty panel labels');labels.add(label)
    return {figureId:identity(panel.figureId),figureRevision:integer(panel.figureRevision,'source revision',1,Number.MAX_SAFE_INTEGER),x,y,width:w,height:h,label}
  })
  return {width,height,panels}
}
export function pngDimensions(bytes:Buffer){
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw new AssemblyError(400,'Assembly sources require actual PNG headers; no implicit format conversion')
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20)
  if(!width||!height||width*height>25000000)throw new AssemblyError(413,'A source PNG exceeds 25 million pixels or has invalid dimensions')
  return {width,height}
}
const xml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!))
/** Fixed-source multi-panel layout; source PNG bytes remain unchanged. */
export class FigureAssemblies{
  private writes:Promise<unknown>=Promise.resolve();private closing=false;private disposing?:Promise<void>
  private constructor(private db:Database,private figures:FigureStudio){}
  static async open(workspace:string,figures:FigureStudio):Promise<FigureAssemblies>{
    const path=join(workspace,'.omicos-oss','assemblies.sqlite');const file=await open(path,'a',0o600);await file.close();await chmod(path,0o600);const db=new DatabaseSync(path)
    try{const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),application=Number(db.prepare('PRAGMA application_id').get()!.application_id);if(version>1||(application!==0&&application!==0x4f41534d)||(version&&application!==0x4f41534d))throw new Error('Unsupported figure assembly database; preserve it');db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');if(!version){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw new Error('Unknown figure assembly database');db.exec(`BEGIN IMMEDIATE; CREATE TABLE assemblies(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,revision)); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,assembly_id TEXT NOT NULL); PRAGMA application_id=${0x4f41534d}; PRAGMA user_version=1; COMMIT;`)}return new FigureAssemblies(db,figures)}catch(error){db.close();throw error}
  }
  private serial<T>(task:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new AssemblyError(409,'Figure assemblies are closing'));const result=this.writes.then(task);this.writes=result.catch(()=>{});return result}
  get(id:string,revision?:number):AssemblyVersion{identity(id);if(revision!==undefined)integer(revision,'revision',1,Number.MAX_SAFE_INTEGER);const row=revision===undefined?this.db.prepare('SELECT record_json FROM assemblies WHERE id=?').get(id):this.db.prepare('SELECT record_json FROM revisions WHERE id=? AND revision=?').get(id,revision);if(!row)throw new AssemblyError(404,'Figure assembly/revision not found');const record=JSON.parse(String(row.record_json)) as AssemblyVersion;if(record.id!==id||(revision!==undefined&&record.revision!==revision)||fingerprint(record)!==record.digest)throw new AssemblyError(409,'Figure assembly identity changed; preserve its database');return record}
  summary(id:string,revision?:number){const record=this.get(id,revision);return {...record,sources:record.sources.map(({figure,width,height})=>({figureId:figure.id,figureRevision:figure.revision,digest:figure.digest,artifact:figure.artifact,review:figure.review,executionId:figure.execution.id,executionState:figure.execution.state,width,height}))}}
  list(query='',before=Number.MAX_SAFE_INTEGER){text(query,'search',200,true);integer(before,'cursor',1,Number.MAX_SAFE_INTEGER);const rows=this.db.prepare("SELECT rowid,id FROM assemblies WHERE rowid<? AND (?='' OR instr(lower(json_extract(record_json,'$.title')||char(10)||json_extract(record_json,'$.caption')),lower(?))>0) ORDER BY rowid DESC LIMIT 51").all(before,query,query);return {entries:rows.slice(0,50).map(row=>{const {id,revision,title,updatedAt,review,layout}=this.get(String(row.id));return {id,revision,title,updatedAt,review,panels:layout.panels.length}}),next:rows.length>50?Number(rows[49].rowid):undefined}}
  history(id:string,before=Number.MAX_SAFE_INTEGER){this.get(id);integer(before,'history cursor',1,Number.MAX_SAFE_INTEGER);const rows=this.db.prepare("SELECT revision,json_extract(record_json,'$.title') AS title,json_extract(record_json,'$.review.state') AS state,json_extract(record_json,'$.updatedAt') AS at FROM revisions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51").all(id,before);return {revisions:rows.slice(0,50).map(row=>({id,revision:Number(row.revision),title:String(row.title),state:String(row.state),updatedAt:String(row.at)})),next:rows.length>50?Number(rows[49].revision):undefined}}
  private replay(operation:string,request:unknown){identity(operation);const row=this.db.prepare('SELECT request_hash,assembly_id FROM operations WHERE id=?').get(operation);if(!row)return;if(row.request_hash!==hash(canonical(request)))throw new AssemblyError(409,'Assembly operation belongs to another request/actor');return this.get(String(row.assembly_id))}
  private commit(record:AssemblyVersion,operation:string,request:unknown){record.digest=fingerprint(record);const json=JSON.stringify(record);if(Buffer.byteLength(json)>4000000)throw new AssemblyError(413,'Assembly source metadata exceeds 4 MB');this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(record.id,record.revision,json);this.db.prepare('INSERT INTO assemblies VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id,json);this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operation,hash(canonical(request)),record.id);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}return record}
  private async image(figureId:string,revision:number){const figure=this.figures.get(figureId,revision);if(figure.artifact.mime!=='image/png')throw new AssemblyError(400,'This layout format embeds PNG originals; export other figure formats separately');const image=await this.figures.artifact(figureId,revision);return {figure,bytes:image.bytes,...pngDimensions(image.bytes)}}
  private budgets(sources:Array<{bytes:Buffer;width:number;height:number}>){if(sources.reduce((sum,source)=>sum+source.bytes.length,0)>32000000||sources.reduce((sum,source)=>sum+source.width*source.height,0)>60000000)throw new AssemblyError(413,'Assembly sources exceed 32 MB or 60 million source pixels')}
  private panelBudgets(layout:AssemblyLayout,images:Array<{figure:{id:string;revision:number};bytes:Buffer;width:number;height:number}>){this.budgets(layout.panels.map(panel=>images.find(image=>key(image.figure.id,image.figure.revision)===key(panel.figureId,panel.figureRevision))!))}
  save(input:AssemblyDraft,actor:string):Promise<AssemblyVersion>{return this.serial(async()=>{
    if(!input||typeof input!=='object')throw new AssemblyError(400,'Assembly draft required');const request={action:'save',input,actor};const replay=this.replay(input.operationId,request);if(replay)return replay
    if(input.id===undefined&&input.revision!==undefined)throw new AssemblyError(400,'Assembly ID required with revision');const old=input.id===undefined?undefined:this.get(input.id);if(old&&old.revision!==input.revision)throw new AssemblyError(409,'Assembly changed; reread before saving')
    const title=text(input.title,'title',200),caption=text(input.caption,'caption',20000,true),layout=assemblyLayout(input.layout);const images:Array<Awaited<ReturnType<FigureAssemblies['image']>>>=[]
    for(const panel of layout.panels){if(images.some(source=>key(source.figure.id,source.figure.revision)===key(panel.figureId,panel.figureRevision)))continue;images.push(await this.image(panel.figureId,panel.figureRevision));this.budgets(images)}
    this.panelBudgets(layout,images)
    const at=new Date().toISOString();return this.commit({id:old?.id||randomUUID(),revision:(old?.revision||0)+1,title,caption,layout,sources:images.map(({bytes,...source})=>source),createdAt:old?.createdAt||at,updatedAt:at,author:actor,digest:'',review:{state:'draft'}},input.operationId,request)
  })}
  async integrity(id:string,revision?:number){const record=this.get(id,revision);const checks=[];for(const {figure} of record.sources){try{const pinned=await this.image(figure.id,figure.revision);if(pinned.figure.digest!==figure.digest||hash(pinned.bytes)!==figure.artifact.sha256||pinned.bytes.length!==figure.artifact.bytes)throw new AssemblyError(409,'Pinned assembly source metadata/bytes changed');let current;try{current=this.figures.get(figure.id)}catch{};checks.push({figureId:figure.id,pinnedRevision:figure.revision,state:current?.digest===figure.digest?'verified' as const:'changed' as const,bytes:'verified' as const,currentRevision:current?.revision,checkedAt:new Date().toISOString()})}catch(error){checks.push({figureId:figure.id,pinnedRevision:figure.revision,state:'unavailable' as const,bytes:'unavailable' as const,reason:String(error),checkedAt:new Date().toISOString()})}}return {id,revision:record.revision,state:checks.every(check=>check.state==='verified')?'verified' as const:'needs-review' as const,checks,scope:'Current source figure metadata and original artifact bytes, not independent scientific validation. Prior assembly assessments remain historical.'}}
  review(input:{id:string;revision:number;operationId:string;decision:'approved'|'changes-requested'|'withdrawn';note:string}):Promise<AssemblyVersion>{return this.serial(async()=>{
    if(!input||typeof input!=='object')throw new AssemblyError(400,'Human assembly review required');const request={action:'review',input,actor:'user:workbench'};const replay=this.replay(input.operationId,request);if(replay)return replay
    const record=this.get(input.id);if(record.revision!==input.revision)throw new AssemblyError(409,'Assembly changed; inspect the current version');if(!['approved','changes-requested','withdrawn'].includes(input.decision))throw new AssemblyError(400,'Choose an assembly review decision');const note=text(input.note,'human review note',10000)
    if(input.decision==='approved'){if(record.sources.some(({figure})=>figure.review.state!=='approved'))throw new AssemblyError(409,'Review each exact source figure first, then capture its approved revision');if((await this.integrity(record.id,record.revision)).state!=='verified')throw new AssemblyError(409,'Source figures changed or disappeared; explicitly recapture and assess a new assembly')}
    const assessedDigest=record.digest;record.revision++;record.updatedAt=new Date().toISOString();record.author='user:workbench';record.review={state:input.decision,note,at:record.updatedAt,assessedDigest};return this.commit(record,input.operationId,request)
  })}
  manifest(id:string,revision?:number){return {schema:'omicos.assembly/1',assembly:this.get(id,revision),scope:'Saved layout and source figure versions, original PNG identities, execution provenance and historical human review. No source-data embedding, automatic secret redaction, scientific validation or publication upload. Current source integrity is separate.'}}
  async svg(id:string,revision?:number):Promise<Buffer>{
    const record=this.get(id,revision);const images:Array<Awaited<ReturnType<FigureAssemblies['image']>>>=[];for(const saved of record.sources){const image=await this.image(saved.figure.id,saved.figure.revision);if(image.figure.digest!==saved.figure.digest||hash(image.bytes)!==saved.figure.artifact.sha256)throw new AssemblyError(409,'Pinned assembly source changed');images.push(image);this.budgets(images)}
    this.panelBudgets(record.layout,images)
    const integrity=await this.integrity(id,record.revision);const metadata={...this.manifest(id,record.revision),currentSourceIntegrity:integrity,exportedAt:new Date().toISOString()}
    const panels=record.layout.panels.map(panel=>{const image=images.find(source=>key(source.figure.id,source.figure.revision)===key(panel.figureId,panel.figureRevision))!;const labelHeight=panel.label?32:0;return `<g><image x="${panel.x}" y="${panel.y+labelHeight}" width="${panel.width}" height="${panel.height-labelHeight}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${image.bytes.toString('base64')}"/>${panel.label?`<text x="${panel.x}" y="${panel.y+24}" font-family="sans-serif" font-size="22" font-weight="bold" fill="#000000">${xml(panel.label)}</text>`:''}</g>`}).join('')
    const svg=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${record.layout.width}" height="${record.layout.height}" viewBox="0 0 ${record.layout.width} ${record.layout.height}"><title>${xml(record.title)}</title><desc>${xml(record.caption)}</desc><metadata>${xml(JSON.stringify(metadata))}</metadata><rect width="100%" height="100%" fill="#ffffff"/>${panels}</svg>`
    if(Buffer.byteLength(svg)>64000000)throw new AssemblyError(413,'SVG assembly export exceeds 64 MB; use fewer panels')
    return Buffer.from(svg)
  }
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.closing=true;return this.disposing=this.writes.then(()=>this.db.close())}
}
