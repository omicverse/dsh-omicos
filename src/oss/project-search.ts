import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {lstat,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {MemoryTree} from './memory-store.js'
import {ProjectDossier} from './dossier.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
export interface SearchHit{projectId:string;workspace:string;kind:'memory'|'dossier';id:string;revision:number;title:string;preview:string;state:string;digest:string;scope?:string}
export interface ProjectSearchPage{hits:SearchHit[];project?:{id:string;workspace:string};kind:'memory'|'dossier';next?:string;unavailable?:string;scanned:number}
export class ProjectSearchError extends Error{constructor(readonly status:number,message:string){super(message)}}
interface Cursor{registry:string;query:string;private:boolean;project:number;kind:'memory'|'dossier';before:number}
/** Owner-only federated reads. No materialized index, worker activation or project creation. */
export async function searchProjects(projects:readonly {id:string;workspace:string}[],query:string,includePrivate=false,encoded?:string):Promise<ProjectSearchPage>{
 if(typeof query!=='string'||!query.trim()||query.length>200)throw new ProjectSearchError(400,'Search requires 1–200 characters')
 const ordered=[...projects].sort((a,b)=>a.id.localeCompare(b.id));const registry=createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
 let cursor:Cursor={registry,query,private:includePrivate,project:0,kind:'memory',before:Number.MAX_SAFE_INTEGER}
 if(encoded){try{if(encoded.length>2000)throw Error();const value=JSON.parse(Buffer.from(encoded,'base64url').toString());if(value.registry!==registry||value.query!==query||value.private!==includePrivate||!Number.isSafeInteger(value.project)||value.project<0||value.project>=ordered.length||!['memory','dossier'].includes(value.kind)||!Number.isSafeInteger(value.before)||value.before<1)throw Error();cursor=value}catch{throw new ProjectSearchError(409,'Search cursor changed or is invalid; restart the search')}}
 const project=ordered[cursor.project],hits:SearchHit[]=[];let scanned=0,more=false,last=cursor.before,unavailable:string|undefined
 if(!project)return {hits,kind:cursor.kind,scanned}
 try{
  if(await realpath(project.workspace)!==project.workspace)throw Error('Registered workspace identity changed')
  const folder=join(project.workspace,'.omicos-oss');if(!(await lstat(folder)).isDirectory()||await realpath(folder)!==folder)throw Error('Project metadata directory identity changed')
  const file=join(folder,cursor.kind==='memory'?'project.sqlite':'dossier.sqlite');if(!(await lstat(file)).isFile()||await realpath(file)!==file)throw Error('Project metadata file identity changed')
  const db=new DatabaseSync(file,{readOnly:true})
  try{
   db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;')
   const application=Number(db.prepare('PRAGMA application_id').get()!.application_id),version=Number(db.prepare('PRAGMA user_version').get()!.user_version)
   if(application!==(cursor.kind==='memory'?0x4f4d4f53:0x4f444f53)||version!==(cursor.kind==='memory'?2:1))throw Error('Unsupported project metadata schema; search does not migrate it')
   const table=cursor.kind==='memory'?'memories':'entries';const rows=db.prepare(`SELECT rowid,id FROM ${table} WHERE rowid<? ORDER BY rowid DESC LIMIT 51`).all(cursor.before)
   const tree=new MemoryTree(db,()=>{throw Error('Read-only search')},()=>undefined)
   for(const row of rows.slice(0,50)){
    scanned++;last=Number(row.rowid)
    if(cursor.kind==='memory'){
     let node;try{node=tree.get(String(row.id),{owner:includePrivate})}catch(error){if((error as any).status===404)continue;throw error}
     if(!includePrivate&&(node.scope==='session'||node.state==='proposed'))continue
     if(!`${node.title}\n${node.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue
     hits.push({...project,projectId:project.id,kind:'memory',id:node.id,revision:node.revision,title:node.title,preview:node.text.slice(0,500),state:node.state,digest:node.digest,scope:node.scope})
    }else{
     const node=ProjectDossier.inspect(db,String(row.id));if(!`${node.title}\n${node.finding}\n${node.limitations}\n${node.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue
     hits.push({projectId:project.id,workspace:project.workspace,kind:'dossier',id:node.id,revision:node.revision,title:node.title,preview:node.finding.slice(0,500),state:node.state,digest:node.digest})
    }
   }
   more=rows.length>50
  }finally{db.close()}
 }catch(error){hits.length=0;unavailable=(error as NodeJS.ErrnoException).code==='ENOENT'?'Metadata is absent; no project was created':String(error)}
 const nextCursor:Cursor=more?{...cursor,before:last}:cursor.kind==='memory'?{...cursor,kind:'dossier',before:Number.MAX_SAFE_INTEGER}:{...cursor,project:cursor.project+1,kind:'memory',before:Number.MAX_SAFE_INTEGER}
 return {hits,project,kind:cursor.kind,scanned,...unavailable?{unavailable}:{},...nextCursor.project<ordered.length?{next:Buffer.from(JSON.stringify(nextCursor)).toString('base64url')}:{}}
}
