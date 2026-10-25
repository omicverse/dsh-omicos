import {EventEmitter} from 'node:events'
import {createRequire} from 'node:module'
import {streamPipelineExport} from '../src/oss/pipeline-export-http.js'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,rename,symlink,unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {PipelineStore} from '../src/oss/pipeline-store.js'
import type {PipelineExport} from '../src/oss/pipeline-export.js'
let directory:string,store:PipelineStore
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oss-pipeline-export-'));store=await PipelineStore.open(directory)})
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true})})
const define=()=>store.define({title:'完整运行 🐟',language:'python',parameters:{species:'人类'},steps:[{id:'only',code:'print("汉字🐟")'}]})
const collect=async(snapshot:PipelineExport)=>{const chunks:Buffer[]=[];for await(const chunk of snapshot.chunks()){expect(chunk.byteLength).toBeLessThanOrEqual(65536);chunks.push(Buffer.from(chunk))}return Buffer.concat(chunks)}
it('exports every run record and event from one immutable WAL snapshot with bounded chunks and exact Unicode bytes',async()=>{
 const definition=define(),created=store.create(definition.id,'export').run
 for(let i=0;i<205;i++)store.update(created.id,undefined,'fixture/event',draft=>{draft.reason=`event ${i}`})
 const run=store.update(created.id,undefined,'fixture/complete',draft=>{draft.state='succeeded';draft.attempts=Array.from({length:65},(_,i)=>({id:`attempt-${i}`,operationId:`attempt-${i}`,step:0,kind:'step',state:'succeeded',outputTail:'汉字🐟é\\n'.repeat(2000)}));(draft.attempts[0] as any).extra='🧬'.repeat(550000)})
 const originalGet=store.get.bind(store);store.get=()=>{throw Error('Full get must not be used for export')};const snapshot=await store.exportRun(run.id,run.revision,new AbortController().signal);store.get=originalGet
 store.update(run.id,run.revision,'fixture/later',draft=>{draft.reason='This later write must not appear in the export'})
 const bytes=await collect(snapshot);expect(bytes.length).toBe(snapshot.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.sha256)
 const document=JSON.parse(bytes.toString('utf8'));expect(document.schema).toBe('omicos.pipeline-run/1');expect(document.definition).toEqual(definition);expect(document.run).toEqual(run);expect(document.run.attempts).toHaveLength(65);expect(document.events).toHaveLength(207);expect(document.events.at(-1).type).toBe('fixture/complete');expect(bytes.toString('utf8')).not.toContain('This later write')
 expect(()=>snapshot.chunks()).toThrow(/only be consumed once/)
})
it('releases snapshot leases for unused streams, aborts, stale revisions and store shutdown without mutating the run',async()=>{
 const definition=define(),run=store.create(definition.id,'lease').run,signal=new AbortController().signal
 await expect(store.exportRun(run.id,run.revision+1,signal)).rejects.toMatchObject({status:409})
 const first=await store.exportRun(run.id,run.revision,signal),second=await store.exportRun(run.id,run.revision,signal)
 await expect(store.exportRun(run.id,run.revision,signal)).rejects.toMatchObject({status:429})
 await first.chunks()[Symbol.asyncIterator]().return?.();second.dispose()
 const caller=new AbortController(),aborted=await store.exportRun(run.id,run.revision,caller.signal),iterator=aborted.chunks()[Symbol.asyncIterator]();await iterator.next();caller.abort();await expect(iterator.next()).rejects.toThrow()
 expect(store.get(run.id)).toEqual(run)
 const closed=await store.exportRun(run.id,run.revision,signal),paused=closed.chunks()[Symbol.asyncIterator]();await paused.next();store.close();await expect(paused.next()).rejects.toThrow();await expect(store.exportRun(run.id,run.revision,signal)).rejects.toMatchObject({status:503})
})

it('rejects changed definitions and malformed event JSON before returning a download descriptor',async()=>{
 const definition=define(),run=store.create(definition.id,'changed').run;const file=join(directory,'.omicos-oss','pipelines.sqlite'),saved=file+'.saved';await rename(file,saved);try{await symlink(saved,file);await expect(store.exportRun(run.id,run.revision,new AbortController().signal)).rejects.toMatchObject({status:409})}finally{await unlink(file);await rename(saved,file)};const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');const db=new DatabaseSync(join(directory,'.omicos-oss','pipelines.sqlite'))
 try{db.prepare("UPDATE runs SET record_json=json_set(record_json,'$.revision',?) WHERE id=?").run(String(run.revision),run.id);await expect(store.exportRun(run.id,run.revision,new AbortController().signal)).rejects.toMatchObject({status:409});db.prepare("UPDATE runs SET record_json=json_set(record_json,'$.revision',?) WHERE id=?").run(run.revision,run.id);db.prepare("UPDATE definitions SET document_json=json_set(document_json,'$.title','Changed') WHERE id=?").run(definition.id);await expect(store.exportRun(run.id,run.revision,new AbortController().signal)).rejects.toMatchObject({status:409});db.prepare('UPDATE definitions SET document_json=? WHERE id=?').run(JSON.stringify(definition),definition.id);db.prepare('UPDATE events SET data_json=? WHERE run_id=?').run('not-json',run.id);await expect(store.exportRun(run.id,run.revision,new AbortController().signal)).rejects.toMatchObject({status:409})}finally{db.close()}
})
it('honors HTTP backpressure and closes only the export observer on disconnect',async()=>{
 for(const mode of ['disconnect','shutdown']){const lease=new AbortController();const request=new EventEmitter() as any;request.aborted=false;const response=new EventEmitter() as any;response.headersSent=false;response.destroyed=false;let writes=0,produced=0,released=0,disposed=0
 response.writeHead=()=>{response.headersSent=true};response.write=()=>{writes++;return false};response.end=vi.fn();response.destroy=()=>{response.destroyed=true;response.emit('close')}
 const source={exportRun:async()=>({signal:lease.signal,bytes:3,sha256:'a'.repeat(64),revision:1,async *chunks(){try{for(let i=0;i<3;i++){produced++;yield Buffer.from('x')}}finally{released++}},dispose(){disposed++}})} as unknown as PipelineStore
 const streaming=streamPipelineExport(request,response,source,'run',1);await vi.waitFor(()=>expect(writes).toBe(1));expect(produced).toBe(1);response.emit('drain');await vi.waitFor(()=>expect(writes).toBe(2));expect(produced).toBe(2);if(mode==='disconnect')response.emit('close');else lease.abort(new Error('Store closed'));await streaming
 expect(released).toBe(1);expect(disposed).toBe(1);expect(response.end).not.toHaveBeenCalled();expect(response.listenerCount('close')).toBe(0);expect(request.listenerCount('aborted')).toBe(0);expect(response.destroyed).toBe(true)}
})
