import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { chmod, link, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { workspacePath } from './files.js'
import { UploadError, portableUploadName, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type DataUpload, type UploadRequest, type UploadSummary } from './upload-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
const identity=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(value))throw new UploadError(400,'Invalid upload/operation identity');return value}
const sha=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-fA-F0-9]{64}$/.test(value))throw new UploadError(400,'Expected a SHA-256 hex digest');return value.toLowerCase()}
export function normalizeUpload(input:UploadRequest):UploadRequest{
  if(!input||typeof input!=='object')throw new UploadError(400,'Upload request required')
  identity(input.operationId)
  if(typeof input.directory!=='string'||input.directory.length>2000||!portableUploadName(input.name))throw new UploadError(400,'Use a portable visible file name and a project-relative destination directory')
  if(!Number.isSafeInteger(input.bytes)||input.bytes<0||input.bytes>UPLOAD_MAX_BYTES||!Array.isArray(input.chunkHashes)||input.chunkHashes.length!==Math.ceil(input.bytes/UPLOAD_CHUNK_BYTES))throw new UploadError(400,'Upload size/4 MiB chunk manifest is invalid; maximum file size is 10 GiB')
  return {operationId:input.operationId,directory:input.directory,name:input.name,bytes:input.bytes,chunkHashes:input.chunkHashes.map(sha),...(input.expectedSha256!==undefined?{expectedSha256:sha(input.expectedSha256)}:{})}
}
async function readBlock(file:FileHandle,size:number,offset:number):Promise<Buffer>{const bytes=Buffer.alloc(size);let read=0;while(read<size){const result=await file.read(bytes,read,size-read,offset+read);if(!result.bytesRead)throw new UploadError(409,'Staging data ended before a committed chunk');read+=result.bytesRead}return bytes}
export class DataUploads{
  private writes:Promise<unknown>=Promise.resolve()
  private closing=false
  private disposing?:Promise<void>
  private finalizers=new Map<string,AbortController>()
  private cancelRequests=new Set<string>()
  private constructor(private db:Database,readonly workspace:string,private sensitive:readonly string[]){}
  static async open(workspace:string,sensitive:readonly string[]):Promise<DataUploads>{
    const root=join(workspace,'.omicos-oss','uploads');await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)throw new UploadError(403,'Upload staging cannot be a symbolic link')
    const path=join(workspace,'.omicos-oss','uploads.sqlite');const file=await open(path,'a',0o600);await file.close();await chmod(path,0o600);const db=new DatabaseSync(path)
    try{const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);const application=Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if(version>1||(application!==0&&application!==0x4f55504c)||(version&&application!==0x4f55504c))throw new Error('Unsupported upload database; preserve it and use a compatible runtime')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if(!version){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw new Error('Unknown upload database');db.exec(`BEGIN IMMEDIATE; CREATE TABLE uploads(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL); PRAGMA application_id=${0x4f55504c}; PRAGMA user_version=1; COMMIT;`)}
      db.exec("CREATE INDEX IF NOT EXISTS upload_state ON uploads(json_extract(record_json,'$.state')); CREATE INDEX IF NOT EXISTS upload_target_state ON uploads(json_extract(record_json,'$.target'),json_extract(record_json,'$.state')); CREATE INDEX IF NOT EXISTS upload_cleanup ON uploads(json_extract(record_json,'$.cleanupPending'));")
      const service=new DataUploads(db,workspace,sensitive);await service.recover();return service
    }catch(error){db.close();throw error}
  }
  private serial<T>(task:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new UploadError(409,'Data import is closing'));const pending=this.writes.then(task);this.writes=pending.catch(()=>{});return pending}
  private stage(id:string){identity(id);return join(this.workspace,'.omicos-oss','uploads',`${id}.part`)}
  private async checkedStage(id:string){const path=this.stage(id);if(await realpath(path)!==path||!(await lstat(path)).isFile())throw new UploadError(403,'Upload staging identity changed');return path}
  get(id:string):DataUpload{identity(id);const row=this.db.prepare('SELECT record_json FROM uploads WHERE id=?').get(id);if(!row)throw new UploadError(404,'Upload not found');const record=JSON.parse(String(row.record_json)) as DataUpload;if(record.id!==id||record.chunkSize!==UPLOAD_CHUNK_BYTES||!Number.isSafeInteger(record.received)||record.received<0||record.received>record.bytes||(record.received%UPLOAD_CHUNK_BYTES!==0&&record.received!==record.bytes))throw new UploadError(409,'Invalid persisted upload identity');try{const {operationId,...definition}=normalizeUpload(record);if(hash(JSON.stringify(definition))!==record.requestSha256||hash(JSON.stringify({bytes:record.bytes,chunkSize:UPLOAD_CHUNK_BYTES,chunkHashes:record.chunkHashes}))!==record.manifestSha256)throw new Error('checksum mismatch')}catch{throw new UploadError(409,'Upload source identity changed; preserve and inspect its metadata')}return record}
  private update(id:string,fields:Partial<DataUpload>):DataUpload{const record={...this.get(id),...fields,updatedAt:new Date().toISOString()};this.db.prepare('UPDATE uploads SET record_json=? WHERE id=?').run(JSON.stringify(record),id);return record}
  list(before=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(before)||before<1)throw new UploadError(400,'Invalid upload page cursor');const rows=this.db.prepare('SELECT rowid,id FROM uploads WHERE rowid<? ORDER BY rowid DESC LIMIT 51').all(before);return {entries:rows.slice(0,50).map(row=>{const {chunkHashes,requestSha256,targetDirectory,targetDirectoryIdentity,...summary}=this.get(String(row.id));return summary as UploadSummary}),next:rows.length>50?Number(rows[49].rowid):undefined,chunkSize:UPLOAD_CHUNK_BYTES,maxBytes:UPLOAD_MAX_BYTES}}
  private async destination(directory:string,name:string):Promise<{directory:string;path:string;target:string;identity:string}>{
    let parent:string;try{parent=await workspacePath(this.workspace,directory,this.sensitive)}catch(error){throw new UploadError(403,String(error))}
    const info=await stat(parent,{bigint:true});if(!info.isDirectory())throw new UploadError(400,'Choose an existing project directory')
    const path=join(parent,name);for(const secret of this.sensitive){let forbidden:string;try{forbidden=await realpath(secret)}catch{forbidden=resolve(secret)}if(path===forbidden)throw new UploadError(403,'Private Host files cannot be import destinations')}
    return {directory:parent,path,target:relative(this.workspace,path).split(sep).join('/'),identity:`${info.dev}:${info.ino}`}
  }
  private async target(record:DataUpload){const destination=await this.destination(record.directory,record.name);if(destination.directory!==record.targetDirectory||destination.target!==record.target||destination.identity!==record.targetDirectoryIdentity)throw new UploadError(409,'Destination directory changed; do not publish into a different location');return destination.path}
  start(input:UploadRequest):Promise<DataUpload>{return this.serial(async()=>{
    const normalized=normalizeUpload(input);const {operationId,...definition}=normalized;const requestSha256=hash(JSON.stringify(definition));const previous=this.db.prepare('SELECT id FROM uploads WHERE operation_id=?').get(operationId)
    if(previous){const record=this.get(String(previous.id));if(record.requestSha256!==requestSha256)throw new UploadError(409,'Upload operation belongs to another file/request');return record}
    const count=Number(this.db.prepare("SELECT COUNT(*) AS count FROM uploads WHERE json_extract(record_json,'$.state') IN ('uploading','finalizing','committing')").get()!.count);if(count>=4)throw new UploadError(409,'Four uploads already reserve staging; complete or cancel one first')
    const destination=await this.destination(normalized.directory,normalized.name)
    try{await lstat(destination.path);throw new UploadError(409,'Destination already exists; choose another file name')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    if(this.db.prepare("SELECT id FROM uploads WHERE json_extract(record_json,'$.target')=? AND json_extract(record_json,'$.state') IN ('uploading','finalizing','committing')").get(destination.target))throw new UploadError(409,'Another unfinished import reserves this destination')
    const id=randomUUID();const file=await open(this.stage(id),'wx',0o600);await file.sync();await file.close();await this.syncDirectory(join(this.workspace,'.omicos-oss','uploads'));const at=new Date().toISOString();const record:DataUpload={...normalized,id,requestSha256,manifestSha256:hash(JSON.stringify({bytes:normalized.bytes,chunkSize:UPLOAD_CHUNK_BYTES,chunkHashes:normalized.chunkHashes})),chunkSize:UPLOAD_CHUNK_BYTES,target:destination.target,targetDirectory:destination.directory,targetDirectoryIdentity:destination.identity,state:'uploading',received:0,createdAt:at,updatedAt:at}
    try{this.db.prepare('INSERT INTO uploads VALUES(?,?,?)').run(id,operationId,JSON.stringify(record))}catch(error){await rm(this.stage(id),{force:true});throw error}return record
  })}
  chunk(id:string,offset:number,bytes:Buffer):Promise<DataUpload>{return this.serial(async()=>{
    const record=this.get(id);if(!Number.isSafeInteger(offset)||offset<0||offset%UPLOAD_CHUNK_BYTES!==0||offset>=record.bytes)throw new UploadError(400,'Invalid upload chunk offset')
    const index=offset/UPLOAD_CHUNK_BYTES;const size=Math.min(UPLOAD_CHUNK_BYTES,record.bytes-offset)
    if(!Buffer.isBuffer(bytes)||bytes.length!==size||hash(bytes)!==record.chunkHashes[index])throw new UploadError(422,'Upload chunk size/hash does not match the approved manifest')
    if(record.state==='completed')return record
    if(record.state!=='uploading'||this.cancelRequests.has(id))throw new UploadError(409,'Upload is not accepting chunks')
    if(offset>record.received)throw new UploadError(409,'Upload has an earlier missing chunk; read the durable offset before continuing')
    const file=await open(await this.checkedStage(id),'r+')
    try{
      if(offset<record.received){const existing=await readBlock(file,size,offset);if(hash(existing)!==record.chunkHashes[index])throw new UploadError(409,'Committed staging bytes changed; cancel and restart this import');return record}
      let written=0;while(written<bytes.length){const result=await file.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw new Error('Upload write made no progress');written+=result.bytesWritten}await file.sync()
      return this.update(id,{received:offset+size,error:undefined})
    }catch(error){await file.truncate(record.received).catch(()=>{});throw error}finally{await file.close()}
  })}
  private async digest(path:string,signal?:AbortSignal):Promise<string>{const digest=createHash('sha256');for await(const bytes of createReadStream(path,{signal}))digest.update(bytes);return digest.digest('hex')}
  private async syncDirectory(path:string){const file=await open(path,'r');try{await file.sync()}finally{await file.close()}}
  private async published(record:DataUpload):Promise<boolean>{const path=await this.target(record);try{const [source,target]=await Promise.all([stat(await this.checkedStage(record.id),{bigint:true}),lstat(path,{bigint:true})]);return target.isFile()&&source.dev===target.dev&&source.ino===target.ino&&source.size===BigInt(record.bytes)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}}
  private async complete(record:DataUpload):Promise<DataUpload>{
    const completed=this.update(record.id,{state:'completed',cleanupPending:true,error:undefined})
    try{await rm(await this.checkedStage(record.id),{force:true});await this.syncDirectory(join(this.workspace,'.omicos-oss','uploads'));return this.update(record.id,{cleanupPending:false})}
    catch(error){try{return this.update(record.id,{error:`Import committed; private staging cleanup remains pending: ${String(error).slice(-1000)}`})}catch{return completed}}
  }
  finalize(id:string):Promise<DataUpload>{return this.serial(async()=>{
    let record=this.get(id);if(record.state==='completed')return record;if(record.state!=='uploading')throw new UploadError(409,'Only a pending upload can be finalized');if(record.received!==record.bytes)throw new UploadError(409,'Wait for all chunks before finalizing')
    const controller=new AbortController();this.finalizers.set(id,controller);if(this.closing||this.cancelRequests.has(id))controller.abort(new Error('Import verification paused'))
    try{
      record=this.update(id,{state:'finalizing',error:undefined});const path=await this.checkedStage(id);const initial=await stat(path,{bigint:true});if(initial.size!==BigInt(record.bytes))throw new UploadError(409,'Staging size changed')
      const sha256=await this.digest(path,controller.signal);if(record.expectedSha256&&sha256!==record.expectedSha256)throw new UploadError(422,'Whole-file SHA-256 differs from the expected source digest')
      // Check each committed chunk again: a final whole-file hash alone has no independent source reference.
      const file=await open(path,'r');try{for(let index=0;index<record.chunkHashes.length;index++){controller.signal.throwIfAborted();const size=Math.min(UPLOAD_CHUNK_BYTES,record.bytes-index*UPLOAD_CHUNK_BYTES);const bytes=await readBlock(file,size,index*UPLOAD_CHUNK_BYTES);if(hash(bytes)!==record.chunkHashes[index])throw new UploadError(422,'Staging data differs from the source chunk manifest')}}finally{await file.close()}
      const observed=await stat(path,{bigint:true});if(initial.size!==observed.size||initial.mtimeNs!==observed.mtimeNs||initial.ino!==observed.ino||initial.dev!==observed.dev)throw new UploadError(409,'Staging data changed during final verification')
      controller.signal.throwIfAborted();record=this.update(id,{state:'committing',sha256});const target=await this.target(record)
      controller.signal.throwIfAborted();try{await link(path,target)}catch(error){if(['EXDEV','ENOTSUP','EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code||''))throw new UploadError(409,'Destination filesystem cannot publish atomic no-overwrite imports; choose a directory on the project filesystem');if((error as NodeJS.ErrnoException).code!=='EEXIST'||!await this.published(record))throw error}
      await this.syncDirectory(record.targetDirectory);return this.complete(record)
    }catch(error){
      const current=this.get(id)
      // An already linked file must be reconciled, even if a late cancellation/shutdown arrives.
      if(current.state==='completed')return current
      if(current.state==='committing'&&await this.published(current)){await this.syncDirectory(current.targetDirectory);return this.complete(current)}
      this.update(id,{state:'uploading',sha256:undefined,error:controller.signal.aborted?'Verification paused; resume explicitly after checking the file.':String(error).slice(-4000)})
      if(error instanceof UploadError)throw error;throw new UploadError(controller.signal.aborted?409:(error as NodeJS.ErrnoException).code==='EEXIST'?409:500,String(error))
    }finally{this.finalizers.delete(id)}
  })}
  cancel(id:string):Promise<DataUpload>{
    const record=this.get(id);if(record.state==='completed')return Promise.reject(new UploadError(409,'Import is already committed; cancel never deletes a project file'))
    this.cancelRequests.add(id);this.finalizers.get(id)?.abort(new Error('Owner canceled upload verification'))
    const task=this.serial(async()=>{try{const current=this.get(id);if(current.state==='completed')throw new UploadError(409,'Import is already committed; cancel never deletes a project file');if(current.state==='canceled')return current;if(current.state==='committing'&&await this.published(current)){await this.syncDirectory(current.targetDirectory);await this.complete(current);throw new UploadError(409,'Import was already published; cancel never deletes a project file')}try{await rm(await this.checkedStage(id),{force:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}await this.syncDirectory(join(this.workspace,'.omicos-oss','uploads'));return this.update(id,{state:'canceled',sha256:undefined,error:undefined})}finally{this.cancelRequests.delete(id)}})
    return task
  }
  private async recover():Promise<void>{
    let after=0
    for(;;){const rows=this.db.prepare("SELECT rowid,id FROM uploads WHERE rowid>? AND json_extract(record_json,'$.state') IN ('uploading','finalizing','committing') OR (rowid>? AND json_extract(record_json,'$.cleanupPending')=1) ORDER BY rowid LIMIT 50").all(after,after);if(!rows.length)return
      for(const row of rows){const record=this.get(String(row.id));try{if(record.state==='completed'){try{await rm(await this.checkedStage(record.id),{force:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}await this.syncDirectory(join(this.workspace,'.omicos-oss','uploads'));this.update(record.id,{cleanupPending:false,error:undefined})}else if(record.state==='committing'&&await this.published(record)){const path=await this.checkedStage(record.id);if(!record.sha256||await this.digest(path)!==record.sha256)throw new Error('Published import bytes changed during recovery');await this.syncDirectory(record.targetDirectory);await this.complete(record)}else{const file=await open(await this.checkedStage(record.id),'r+');try{if((await file.stat()).size<record.received)throw new Error('Staging data is shorter than committed progress');await file.truncate(record.received);await file.sync()}finally{await file.close()}this.update(record.id,{state:'uploading',sha256:undefined,error:'Host restarted; reselect the source file and resume explicitly.'})}}catch(error){this.update(record.id,{state:record.state==='completed'?'completed':'failed',error:String(error).slice(-4000)})}}
      after=Number(rows.at(-1)!.rowid)
    }
  }
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.closing=true;for(const controller of this.finalizers.values())controller.abort(new Error('Host shutting down'));return this.disposing=this.writes.then(()=>this.db.close())}
}
