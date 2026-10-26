import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OssRuntime } from '../src/oss/runtime.js'
import { normalizeUpload } from '../src/oss/uploads.js'
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type DataUpload } from '../src/oss/upload-types.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
let directory:string;let runtime:OssRuntime
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oss-import-'));runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/must-not-run-for-data-import'});await runtime.project(directory)})
afterEach(async()=>{await runtime.dispose();await rm(directory,{recursive:true,force:true})})
function request(bytes:Buffer,operationId='import',name='data.bin'){const chunkHashes=[];for(let offset=0;offset<bytes.length;offset+=UPLOAD_CHUNK_BYTES)chunkHashes.push(sha(bytes.subarray(offset,offset+UPLOAD_CHUNK_BYTES)));return {operationId,directory:'',name,bytes:bytes.length,chunkHashes,expectedSha256:sha(bytes)}}
const stage=(record:DataUpload)=>join(record.targetDirectory,'.omicos-oss','uploads',`${record.id}.part`)
async function restart(){await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/must-not-run-for-data-import'})}
describe('durable verified data import without execution',()=>{
  it('resumes committed offsets, deduplicates exact chunk retries and atomically publishes full verified bytes without running Python',async()=>{
    let uploads=await runtime.uploads(directory);const bytes=Buffer.alloc(UPLOAD_CHUNK_BYTES+123,7);bytes[0]=41;bytes[bytes.length-1]=42;const input=request(bytes);const record=await uploads.start(input)
    expect((await uploads.start(input)).id).toBe(record.id);await expect(uploads.start({...input,name:'different.bin'})).rejects.toMatchObject({status:409})
    await expect(uploads.chunk(record.id,UPLOAD_CHUNK_BYTES,bytes.subarray(UPLOAD_CHUNK_BYTES))).rejects.toMatchObject({status:409})
    await expect(uploads.chunk(record.id,0,Buffer.alloc(UPLOAD_CHUNK_BYTES,9))).rejects.toMatchObject({status:422})
    const first=await uploads.chunk(record.id,0,bytes.subarray(0,UPLOAD_CHUNK_BYTES));expect(first.received).toBe(UPLOAD_CHUNK_BYTES);expect((await uploads.chunk(record.id,0,bytes.subarray(0,UPLOAD_CHUNK_BYTES))).received).toBe(UPLOAD_CHUNK_BYTES)
    await expect(uploads.finalize(record.id)).rejects.toMatchObject({status:409});await expect(stat(join(directory,'data.bin'))).rejects.toMatchObject({code:'ENOENT'})
    await restart();uploads=await runtime.uploads(directory);expect(uploads.get(record.id).received).toBe(UPLOAD_CHUNK_BYTES)
    await uploads.chunk(record.id,UPLOAD_CHUNK_BYTES,bytes.subarray(UPLOAD_CHUNK_BYTES));const completed=await uploads.finalize(record.id);expect(completed.state).toBe('completed');expect(completed.sha256).toBe(sha(bytes));expect(completed.cleanupPending).toBe(false);expect((await readFile(join(directory,'data.bin'))).equals(bytes)).toBe(true)
    expect((await uploads.finalize(record.id)).sha256).toBe(completed.sha256);expect((await uploads.chunk(record.id,0,bytes.subarray(0,UPLOAD_CHUNK_BYTES))).state).toBe('completed');await expect(uploads.cancel(record.id)).rejects.toMatchObject({status:409})
    expect((await runtime.project(directory)).snapshot().executions).toEqual([]);expect((await runtime.project(directory)).kernelState().state).toBe('cold')
  },30000)
  it('refuses overwrite/private/escaped destinations, rechecks directory identity and supports empty files',async()=>{
    const uploads=await runtime.uploads(directory);await writeFile(join(directory,'exists.csv'),'original');await expect(uploads.start(request(Buffer.from('replacement'),'overwrite','exists.csv'))).rejects.toMatchObject({status:409});expect(await readFile(join(directory,'exists.csv'),'utf8')).toBe('original')
    for(const input of [{...request(Buffer.alloc(0),'private'),directory:'.omicos-oss'}, {...request(Buffer.alloc(0),'escape'),directory:'../outside'},{...request(Buffer.alloc(0),'env'),name:'.env'}])await expect(uploads.start(input)).rejects.toThrow()
    await mkdir(join(directory,'folder'));const record=await uploads.start({...request(Buffer.from('dataset'),'folder'),directory:'folder'});await uploads.chunk(record.id,0,Buffer.from('dataset'));await rename(join(directory,'folder'),join(directory,'old-folder'));await mkdir(join(directory,'folder'));await expect(uploads.finalize(record.id)).rejects.toMatchObject({status:409});await expect(stat(join(directory,'folder','data.bin'))).rejects.toMatchObject({code:'ENOENT'})
    const empty=await uploads.start(request(Buffer.alloc(0),'empty','empty.txt'));expect((await uploads.finalize(empty.id)).sha256).toBe(sha(Buffer.alloc(0)));expect((await stat(join(directory,'empty.txt'))).size).toBe(0)
    await symlink(join(directory,'exists.csv'),join(directory,'linked.csv'));await expect(uploads.start(request(Buffer.from('other'),'link','linked.csv'))).rejects.toMatchObject({status:409})
  })
  it('checks whole-file expectations and staging tampering before publish, preserves conflicts and cancels only private partial files',async()=>{
    const uploads=await runtime.uploads(directory);const bytes=Buffer.from('actual bytes');const bad=await uploads.start({...request(bytes,'bad','wrong.bin'),expectedSha256:'0'.repeat(64)});await uploads.chunk(bad.id,0,bytes);await expect(uploads.finalize(bad.id)).rejects.toMatchObject({status:422});await expect(stat(join(directory,'wrong.bin'))).rejects.toMatchObject({code:'ENOENT'});expect((await uploads.cancel(bad.id)).state).toBe('canceled');expect((await uploads.cancel(bad.id)).state).toBe('canceled')
    const conflict=await uploads.start(request(bytes,'conflict','conflict.bin'));await uploads.chunk(conflict.id,0,bytes);await writeFile(join(directory,'conflict.bin'),'external bytes');await expect(uploads.finalize(conflict.id)).rejects.toMatchObject({status:409});expect(await readFile(join(directory,'conflict.bin'),'utf8')).toBe('external bytes');await uploads.cancel(conflict.id);expect(await readFile(join(directory,'conflict.bin'),'utf8')).toBe('external bytes')
    const tampered=await uploads.start({...request(bytes,'tamper','tampered.bin'),expectedSha256:undefined});await uploads.chunk(tampered.id,0,bytes);await writeFile(stage(tampered),Buffer.alloc(bytes.length,8));await expect(uploads.finalize(tampered.id)).rejects.toMatchObject({status:422});await expect(uploads.chunk(tampered.id,0,bytes)).rejects.toMatchObject({status:409})
    const paused=await uploads.start(request(Buffer.from('cancel before finalize'),'cancel','paused.bin'));await uploads.chunk(paused.id,0,Buffer.from('cancel before finalize'));const finalize=uploads.finalize(paused.id);const cancellation=uploads.cancel(paused.id);await expect(finalize).rejects.toMatchObject({status:409});expect((await cancellation).state).toBe('canceled');await expect(stat(join(directory,'paused.bin'))).rejects.toMatchObject({code:'ENOENT'})
  })
  it('truncates uncommitted append bytes on restart and reconciles a linked commit by inode, not matching file names or hashes',async()=>{
    let uploads=await runtime.uploads(directory);const bytes=Buffer.from('verified publication');const pending=await uploads.start(request(bytes,'tail','tail.bin'));await appendFile(stage(pending),'uncommitted')
    const linked=await uploads.start(request(bytes,'linked','published.bin'));await uploads.chunk(linked.id,0,bytes)
    const collision=await uploads.start(request(bytes,'collision','collision.bin'));await uploads.chunk(collision.id,0,bytes)
    const workspace=(await runtime.project(directory)).workspace;await runtime.dispose();const db=new DatabaseSync(join(workspace,'.omicos-oss','uploads.sqlite'))
    for(const record of [linked,collision]){const current=JSON.parse(String(db.prepare('SELECT record_json FROM uploads WHERE id=?').get(record.id)!.record_json));db.prepare('UPDATE uploads SET record_json=? WHERE id=?').run(JSON.stringify({...current,state:'committing',sha256:sha(bytes)}),record.id)}db.close()
    await link(stage(linked),join(directory,'published.bin'));await writeFile(join(directory,'collision.bin'),bytes)
    runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/must-not-run'});uploads=await runtime.uploads(directory)
    expect((await stat(stage(pending))).size).toBe(0);expect(uploads.get(pending.id).received).toBe(0);expect(uploads.get(linked.id).state).toBe('completed');expect(uploads.get(collision.id).state).toBe('uploading');await expect(uploads.finalize(collision.id)).rejects.toMatchObject({status:409});expect(await readFile(join(directory,'collision.bin'))).toEqual(bytes)
  })
  it('bounds file sizes, active staging and discovery pages; old canceled operation retries never create a new upload',async()=>{
    const uploads=await runtime.uploads(directory)
    for(const invalid of [{...request(Buffer.alloc(0)),bytes:UPLOAD_MAX_BYTES+1},{...request(Buffer.from('x')),chunkHashes:[]},{...request(Buffer.alloc(0)),name:'CON.txt'},{...request(Buffer.alloc(0)),name:'x/../file'}])expect(()=>normalizeUpload(invalid)).toThrow()
    const active=[];for(let index=0;index<4;index++)active.push(await uploads.start(request(Buffer.alloc(0),`active-${index}`,`file-${index}.bin`)))
    await expect(uploads.start(request(Buffer.alloc(0),'overflow','overflow.bin'))).rejects.toMatchObject({status:409});for(const record of active)await uploads.cancel(record.id)
    for(let index=0;index<51;index++){const record=await uploads.start(request(Buffer.alloc(0),`history-${index}`,`history-${index}.bin`));await uploads.cancel(record.id)}
    const first=uploads.list();const next=uploads.list(first.next);expect(first.entries).toHaveLength(50);expect(next.entries).toHaveLength(5);expect(first.entries[0]).not.toHaveProperty('chunkHashes');expect((await uploads.start(request(Buffer.alloc(0),'active-0','file-0.bin'))).state).toBe('canceled');expect(()=>uploads.list(0)).toThrow(/cursor/)
  },30000)
})
it('recovers a crash during owned-stage adoption without truncating the shared remote source inode',async()=>{
 const downloadId='owned-download-fixture',bytes=Buffer.from('preserve these downloaded bytes'),input=request(bytes,`remote-${downloadId}`,'remote.txt');let uploads=await runtime.uploads(directory);const record=await uploads.start(input);await mkdir(join(directory,'.omicos-oss','downloads'));const source=join(directory,'.omicos-oss','downloads',downloadId+'.part');await writeFile(source,bytes);await rm(stage(record));await link(source,stage(record));await runtime.dispose();const db=new DatabaseSync(join(directory,'.omicos-oss','uploads.sqlite'));try{db.prepare("UPDATE uploads SET record_json=json_set(record_json,'$.state','adopting','$.downloadId',?) WHERE id=?").run(downloadId,record.id)}finally{db.close()};runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/must-not-run-for-data-import'});uploads=await runtime.uploads(directory);expect(await readFile(source)).toEqual(bytes);expect(uploads.get(record.id)).toMatchObject({state:'uploading',received:bytes.length,downloadId});expect((await uploads.adoptDownloaded(input,downloadId)).state).toBe('completed');expect(await readFile(join(directory,'remote.txt'))).toEqual(bytes);expect(await readFile(source)).toEqual(bytes);await expect(uploads.adoptDownloaded({...input,operationId:'another-op'},downloadId)).rejects.toMatchObject({status:400})
})
