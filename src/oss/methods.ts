import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmod, open } from 'node:fs/promises'
import { join } from 'node:path'
import { SCIENTIFIC_SKILLS } from './skills.js'
import type { PipelineReference } from './pipeline-types.js'
import { MethodError, type MethodPack, type MethodRecord, type MethodReview, type ScientificMethod, type MethodAssessment } from './method-types.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
export const METHOD_PREFIX='omicos-method:'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
function sort(value:any):any{return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,sort(value[key])])):value}
export const methodText=(value:ScientificMethod)=>JSON.stringify(sort(value))
const text=(value:unknown,field:string,max:number,empty=false):string=>{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max)throw new MethodError(400,`Invalid method ${field}`);return value}
const digestId=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new MethodError(400,'Invalid method content SHA-256');return value}
const operationId=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(value))throw new MethodError(400,'Stable method operation ID required');return value}
const cursor=(value:number)=>{if(!Number.isSafeInteger(value)||value<1)throw new MethodError(400,'Invalid method page cursor');return value}
export function normalizeMethod(value:ScientificMethod):ScientificMethod{
  if(!value||typeof value!=='object'||!value.license)throw new MethodError(400,'Method document and declared license required')
  const key=text(value.key,'key',150);const version=text(value.version,'version',100)
  if(!/^[a-z0-9][a-z0-9._-]*$/.test(key)||!/^[0-9][a-zA-Z0-9.+_-]*$/.test(version))throw new MethodError(400,'Use a stable lowercase method key and explicit version string')
  if(!Array.isArray(value.authors)||!value.authors.length||value.authors.length>20||!Array.isArray(value.sources)||value.sources.length>20)throw new MethodError(400,'Declare 1–20 authors and at most 20 source URLs')
  const document={key,version,title:text(value.title,'title',200),description:text(value.description,'description',2000),body:text(value.body,'guidance body',32000),authors:value.authors.map(item=>text(item,'author',200)),sources:value.sources.map(item=>{const source=text(item,'HTTPS source',1000);let url:URL;try{url=new URL(source)}catch{throw new MethodError(400,'Method sources must be HTTPS URLs')}if(url.protocol!=='https:'||url.username||url.password)throw new MethodError(400,'Method sources must be credential-free HTTPS URLs');return source}),license:{id:text(value.license.id,'declared license id',200),text:text(value.license.text,'license text',8000,true)}}
  if(methodText(document).length>45000)throw new MethodError(413,'Method document exceeds the 45000-character Pipeline pin limit')
  return document
}
export function builtinMethodPack():MethodPack{return {schema:'omicos.methods/1',methods:Object.entries(SCIENTIFIC_SKILLS).map(([key,value])=>({key:`builtin.${key}`,version:'1.0.0',...value,authors:['OmicOS OSS contributors'],sources:['https://github.com/omicverse/dsh-omicos'],license:{id:'GPL-3.0-only',text:'Original public OmicOS OSS guidance; see the project LICENSE. Scientific applicability still requires human review.'}}))}}
export class ScientificMethods{
  private writes:Promise<unknown>=Promise.resolve()
  private closing=false
  private disposing?:Promise<void>
  private constructor(private db:Database){}
  static async open(workspace:string):Promise<ScientificMethods>{
    const path=join(workspace,'.omicos-oss','methods.sqlite');const file=await open(path,'a',0o600);await file.close();await chmod(path,0o600);const db=new DatabaseSync(path)
    try{const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);const application=Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if(version>1||(application!==0&&application!==0x4f4d4554)||(version&&application!==0x4f4d4554))throw new Error('Unsupported scientific method database; preserve it and use a compatible runtime')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if(!version){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw new Error('Unknown scientific method database');db.exec(`BEGIN IMMEDIATE; CREATE TABLE methods(id TEXT PRIMARY KEY,method_key TEXT NOT NULL,version TEXT NOT NULL,document_json TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL,UNIQUE(method_key,version)); CREATE TABLE reviews(id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,revision)); CREATE TABLE current_reviews(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_ids TEXT NOT NULL); CREATE INDEX method_review_state ON current_reviews(state); PRAGMA application_id=${0x4f4d4554}; PRAGMA user_version=1; COMMIT;`)}
      return new ScientificMethods(db)
    }catch(error){db.close();throw error}
  }
  private serial<T>(action:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new MethodError(409,'Method library is closing'));const task=this.writes.then(action);this.writes=task.catch(()=>{});return task}
  get(id:string):MethodRecord{
    digestId(id);const row=this.db.prepare('SELECT * FROM methods WHERE id=?').get(id);if(!row)throw new MethodError(404,'Scientific method version not found')
    let document:ScientificMethod;try{document=normalizeMethod(JSON.parse(String(row.document_json)));if(hash(methodText(document))!==id||document.key!==row.method_key||document.version!==row.version)throw new Error('identity changed')}catch{throw new MethodError(409,'Scientific method content identity changed; preserve and inspect the database')}
    const current=this.db.prepare('SELECT revision,state FROM current_reviews WHERE id=?').get(id);if(!current)throw new MethodError(409,'Method review pointer missing');const review=this.reviewVersion(id,Number(current.revision));if(review.state!==current.state)throw new MethodError(409,'Method review pointer changed')
    return {id,document,createdAt:String(row.created_at),proposedBy:String(row.actor),review}
  }
  private reviewVersion(id:string,revision:number):MethodReview{const row=this.db.prepare('SELECT record_json FROM reviews WHERE id=? AND revision=?').get(id,revision);if(!row)throw new MethodError(404,'Method review revision not found');const review=JSON.parse(String(row.record_json)) as MethodReview;if(review.id!==id||review.revision!==revision||!['draft','published','withdrawn'].includes(review.state))throw new MethodError(409,'Invalid method review identity');return review}
  list(query='',state='',before=Number.MAX_SAFE_INTEGER){cursor(before);text(query,'query',200,true);if(state&&!['draft','published','withdrawn'].includes(state))throw new MethodError(400,'Invalid method review state');const rows=this.db.prepare(`SELECT m.rowid,m.id FROM methods m JOIN current_reviews r ON r.id=m.id WHERE m.rowid<? AND (?='' OR r.state=?) AND (?='' OR instr(lower(m.method_key||char(10)||json_extract(m.document_json,'$.title')||char(10)||json_extract(m.document_json,'$.description')),lower(?))>0) ORDER BY m.rowid DESC LIMIT 51`).all(before,state,state,query,query);return {entries:rows.slice(0,50).map(row=>{const record=this.get(String(row.id));const {key,version,title,description,license}=record.document;return {id:record.id,key,version,title,description,licenseId:license.id,review:record.review}}),next:rows.length>50?Number(rows[49].rowid):undefined}}
  history(id:string,before=Number.MAX_SAFE_INTEGER){this.get(id);cursor(before);const rows=this.db.prepare('SELECT revision FROM reviews WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51').all(id,before);return {reviews:rows.slice(0,50).map(row=>this.reviewVersion(id,Number(row.revision))),next:rows.length>50?Number(rows[49].revision):undefined}}
  private replay(operation:string,request:unknown):MethodRecord[]|undefined{operationId(operation);const row=this.db.prepare('SELECT request_hash,result_ids FROM operations WHERE id=?').get(operation);if(!row)return;if(row.request_hash!==hash(JSON.stringify(sort(request))))throw new MethodError(409,'Method operation belongs to another request or actor');return (JSON.parse(String(row.result_ids)) as string[]).map(id=>this.get(id))}
  private operation(operation:string,request:unknown,ids:string[]){this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operation,hash(JSON.stringify(sort(request))),JSON.stringify(ids))}
  importPack(input:MethodPack,operation:string,actor:string):Promise<MethodRecord[]>{return this.serial(async()=>{
    if(!input||input.schema!=='omicos.methods/1'||!Array.isArray(input.methods)||!input.methods.length||input.methods.length>20||Buffer.byteLength(JSON.stringify(input))>1000000)throw new MethodError(400,'Use omicos.methods/1 with 1–20 method documents below 1 MB')
    const documents=input.methods.map(normalizeMethod);const request={action:'import',documents,actor};const replay=this.replay(operation,request);if(replay)return replay
    if(new Set(documents.map(value=>`${value.key}@${value.version}`)).size!==documents.length)throw new MethodError(400,'Duplicate method key/version in pack')
    const ids=documents.map(value=>hash(methodText(value)));for(let index=0;index<documents.length;index++){const existing=this.db.prepare('SELECT id FROM methods WHERE method_key=? AND version=?').get(documents[index].key,documents[index].version);if(existing&&existing.id!==ids[index])throw new MethodError(409,'A method version is immutable; increment its version before changing content')}
    const at=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE')
    try{for(let index=0;index<documents.length;index++){const id=ids[index];const document=documents[index];if(this.db.prepare('SELECT id FROM methods WHERE id=?').get(id))continue;this.db.prepare('INSERT INTO methods VALUES(?,?,?,?,?,?)').run(id,document.key,document.version,methodText(document),at,actor);const review:MethodReview={id,revision:1,state:'draft',actor,note:'Imported as unreviewed guidance. Explicit local human publication required.',at};this.db.prepare('INSERT INTO reviews VALUES(?,?,?)').run(id,1,JSON.stringify(review));this.db.prepare('INSERT INTO current_reviews VALUES(?,?,?)').run(id,1,'draft')}this.operation(operation,request,ids);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
    return ids.map(id=>this.get(id))
  })}
  review(input:{id:string;revision:number;operationId:string;action:'publish'|'withdraw';note:string}):Promise<MethodRecord>{return this.serial(async()=>{
    if(!input||typeof input!=='object')throw new MethodError(400,'Human method review required');const request={action:'review',input,actor:'user:workbench'};const replay=this.replay(input.operationId,request);if(replay)return replay[0]
    const record=this.get(input.id);if(record.review.revision!==input.revision)throw new MethodError(409,'Method review changed; reread before deciding');if(!['publish','withdraw'].includes(input.action))throw new MethodError(400,'Choose publish or withdraw');const note=text(input.note,'human review note',4000);const state=input.action==='publish'?'published':'withdrawn';if(record.review.state===state)throw new MethodError(409,'Method already has this review state')
    const review:MethodReview={id:record.id,revision:record.review.revision+1,state,actor:'user:workbench',note,at:new Date().toISOString()};this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO reviews VALUES(?,?,?)').run(record.id,review.revision,JSON.stringify(review));this.db.prepare('UPDATE current_reviews SET revision=?,state=? WHERE id=?').run(review.revision,state,record.id);this.operation(input.operationId,request,[record.id]);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}return this.get(record.id)
  })}
  reference(id:string):PipelineReference{const record=this.get(id);if(record.review.state!=='published')throw new MethodError(409,'Publish this exact method version locally before pinning it');const text=methodText(record.document);return {id:`${METHOD_PREFIX}${id}`,version:record.document.version,text,sha256:hash(text)}}
  validateReferences(references:readonly PipelineReference[]):MethodAssessment[]{const assessments:MethodAssessment[]=[];for(const reference of references){if(!reference.id.trim().toLowerCase().startsWith(METHOD_PREFIX))continue;if(!reference.id.startsWith(METHOD_PREFIX))throw new MethodError(409,'Malformed managed method reference prefix');const id=reference.id.slice(METHOD_PREFIX.length);let record:MethodRecord;try{record=this.get(id);const pinned=this.reference(id);if(reference.version!==pinned.version||reference.text!==pinned.text||reference.sha256!==pinned.sha256)throw new MethodError(409,'Managed reference bytes/version differ from the local method')}catch(error){throw new MethodError(409,`Managed scientific method cannot execute: ${String(error)}`)}assessments.push({id,version:reference.version,sha256:reference.sha256,reviewRevision:record.review.revision,reviewedAt:record.review.at})}return assessments}
  export(id:string){const record=this.get(id);return {schema:'omicos.methods/1' as const,methods:[record.document],originReceipts:[{id:record.id,proposedBy:record.proposedBy,review:record.review}],approvalTransfer:'none; importing projects require their own human review'}}
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.closing=true;return this.disposing=this.writes.then(()=>this.db.close())}
}
