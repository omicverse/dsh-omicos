import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PipelineService } from '../src/oss/pipelines.js'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { ScienceService } from '../src/oss/science.js'
import { builtinMethodPack, normalizeMethod } from '../src/oss/methods.js'
import type { ScientificMethod } from '../src/oss/method-types.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
let rAvailable=false
try{await promisify(execFile)('Rscript',['--vanilla','-e','stopifnot(requireNamespace("jsonlite",quietly=TRUE))'],{timeout:10000});rAvailable=true}catch{}
let directory:string;let runtime:OssRuntime;const workers:ScienceService[]=[]
const method=(key='lab.inspect',version='1.0.0'):ScientificMethod=>({key,version,title:'Inspect source evidence',description:'Fixture guidance with explicit uncertainty',body:'Check the actual source and preserve raw observations. Execution is not scientific validation.',authors:['Test author'],sources:['https://example.org/method'],license:{id:'MIT',text:'Fixture-authored guidance; license declaration retained.'}})
const pack=(...methods:ScientificMethod[])=>({schema:'omicos.methods/1' as const,methods})
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oss-methods-'));runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/not-used-for-method-metadata'});await runtime.project(directory)})
afterEach(async()=>{await Promise.all(workers.splice(0).map(worker=>worker.dispose()));await runtime.dispose();await rm(directory,{recursive:true,force:true})})
async function settled(worker:ScienceService,id:string){const deadline=Date.now()+12000;while(Date.now()<deadline){const record=worker.get(id)!;if(!['queued','running'].includes(record.state))return record;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Worker did not settle')}
describe('immutable reviewed scientific method library',()=>{
  it('imports drafts, preserves exact bytes/licenses, forbids version mutation and atomically rejects conflicted packs',async()=>{
    const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method()),'import','agent:one');expect(draft.review.state).toBe('draft');expect(draft.document.license.id).toBe('MIT');expect(draft.id).toMatch(/^[a-f0-9]{64}$/)
    expect((await methods.importPack(pack(method()),'import','agent:one'))[0]).toEqual(draft);await expect(methods.importPack(pack(method()),'import','agent:two')).rejects.toMatchObject({status:409})
    await expect(methods.importPack(pack(method('lab.new'),{...method(),body:'changed bytes under old version'}),'conflict','user:workbench')).rejects.toMatchObject({status:409});expect(methods.list().entries).toHaveLength(1)
    expect(()=>methods.reference(draft.id)).toThrow(/Publish/);await expect(methods.review({id:draft.id,revision:1,operationId:'empty-review',action:'publish',note:''})).rejects.toMatchObject({status:400})
    expect((await runtime.project(directory)).kernelState().state).toBe('cold');expect((await stat(join(directory,'.omicos-oss','methods.sqlite'))).mode&0o777).toBe(0o600)
    expect(()=>normalizeMethod({...method(),sources:['javascript:alert(1)']})).toThrow(/HTTPS/);expect(()=>normalizeMethod({...method(),sources:['https://user:password@example.org/method']})).toThrow(/credential/)
  })
  it('records CAS human publication/withdrawal, never restores old approval on replay/reimport, and does not transfer approval through export',async()=>{
    const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method()),'import','agent:session');const publish={id:draft.id,revision:1,operationId:'publish',action:'publish' as const,note:'Human checked source, version, scope and license declaration'};const published=await methods.review(publish);expect(published.review.state).toBe('published');const reference=methods.reference(draft.id);expect(reference.sha256).toBe(draft.id)
    await expect(methods.review({...publish,operationId:'stale'})).rejects.toMatchObject({status:409})
    const exported=methods.export(draft.id);const other=await runtime.methods(join(directory,'other-project'));const [foreign]=await other.importPack(exported,'foreign','user:workbench');expect(foreign.review.state).toBe('draft')
    const withdrawn=await methods.review({id:draft.id,revision:2,operationId:'withdraw',action:'withdraw',note:'Method needs reassessment'});expect((await methods.review(publish)).review.state).toBe('withdrawn');expect((await methods.importPack(pack(method()),'again','user:workbench'))[0].review.state).toBe('withdrawn');expect(()=>methods.validateReferences([reference])).toThrow(/cannot execute/)
    const restored=await methods.review({id:draft.id,revision:withdrawn.review.revision,operationId:'restore',action:'publish',note:'Explicitly restored after reassessment'});expect(restored.review.revision).toBe(4);expect(methods.history(draft.id).reviews.map(review=>review.state)).toEqual(['published','withdrawn','published','draft'])
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/not-used'});expect((await runtime.methods(directory)).get(draft.id)).toEqual(restored)
  })
  it('pages method versions/reviews and preserves the four public bundled checklist identities',async()=>{
    const methods=await runtime.methods(directory);for(let base=0;base<55;base+=20)await methods.importPack(pack(...Array.from({length:Math.min(20,55-base)},(_,offset)=>method(`lab.method-${base+offset}`))),`pack-${base}`,'user:workbench')
    const first=methods.list();expect(first.entries).toHaveLength(50);expect(methods.list('','',first.next).entries).toHaveLength(5);expect(methods.list('method-0').entries).toHaveLength(1)
    let record=methods.get(first.entries[0].id);for(let index=0;index<55;index++)record=await methods.review({id:record.id,revision:record.review.revision,action:index%2?'withdraw':'publish',note:`Review ${index}`,operationId:`review-${index}`})
    const history=methods.history(record.id);expect(history.reviews).toHaveLength(50);expect(methods.history(record.id,history.next).reviews).toHaveLength(6);expect(()=>methods.list('','',0)).toThrow(/cursor/)
    const builtins=builtinMethodPack();expect(builtins.methods.map(item=>item.key)).toEqual(['builtin.anndata-audit','builtin.single-cell-qc','builtin.differential-expression','builtin.scientific-figures']);expect(builtins.methods.every(item=>item.license.id==='GPL-3.0-only')).toBe(true)
  })
  it('rejects forged managed references and changed stored source documents without launching a worker',async()=>{
    const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method()),'import','user:workbench');await methods.review({id:draft.id,revision:1,operationId:'publish',action:'publish',note:'Fixture reviewed'});const reference=methods.reference(draft.id);expect(()=>methods.validateReferences([{...reference,version:'9.0.0'}])).toThrow(/cannot execute/)
    const pipelines=await runtime.pipelines(directory);expect(()=>pipelines.define({title:'Forged',language:'python',references:[{...reference,text:'fake text',sha256:createHash('sha256').update('fake text').digest('hex')}],steps:[{id:'s',code:'print(42)'}]})).toThrow(/Managed scientific method cannot execute/)
    const unconfigured=await PipelineService.open(join(directory,'unconfigured'),'/must-not-run','Rscript',[],[]);try{expect(()=>unconfigured.define({title:'Missing registry',language:'python',references:[reference],steps:[{id:'s',code:'print(42)'}]})).toThrow(/registry is unavailable/)}finally{await unconfigured.dispose()}
    const workspace=(await runtime.project(directory)).workspace;await runtime.dispose();const db=new DatabaseSync(join(workspace,'.omicos-oss','methods.sqlite'));db.prepare('UPDATE methods SET document_json=? WHERE id=?').run(JSON.stringify({...draft.document,body:'tampered'}),draft.id);db.close();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:'/must-not-run'});const recovered=await runtime.methods(directory);expect(()=>recovered.get(draft.id)).toThrow(/identity changed/);expect((await runtime.project(directory)).kernelState().state).toBe('cold')
  })
  it('runs a real pinned Pipeline, blocks a withdrawn gate and records exact review revisions at actual dispatch',async()=>{
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:process.env.OMICOS_SCIENCE_TEST_PYTHON||'python3'});const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method()),'import','user:workbench');await methods.review({id:draft.id,revision:1,operationId:'publish',action:'publish',note:'Source inspected'});const reference=methods.reference(draft.id);const pipelines=await runtime.pipelines(directory)
    const definition=pipelines.define({title:'Reviewed method run',language:'python',references:[reference],steps:[{id:'prepare',code:'value = 40'},{id:'report',gate:true,code:'from pathlib import Path\nPath("method-result.txt").write_text(str(value+2))\nprint(value+2)'}]});let run=pipelines.start(definition.id,'method-run');const deadline=Date.now()+12000;while(run.state!=='waiting'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));run=pipelines.get(run.id)}expect(run.state).toBe('waiting');expect(run.attempts[0].methodReviews?.[0].reviewRevision).toBe(2)
    await methods.review({id:draft.id,revision:2,operationId:'withdraw',action:'withdraw',note:'Pause further use'});await expect(pipelines.control(run.id,run.revision,'continue')).rejects.toMatchObject({status:409});await expect(readFile(join(directory,'method-result.txt'))).rejects.toMatchObject({code:'ENOENT'});expect(pipelines.get(run.id).state).toBe('waiting');expect(()=>pipelines.start(definition.id,'new-disallowed-run')).toThrow(/cannot execute/);expect(pipelines.start(definition.id,'method-run').id).toBe(run.id)
    await methods.review({id:draft.id,revision:3,operationId:'restore',action:'publish',note:'Restored after review'});await pipelines.control(run.id,run.revision,'continue');while(!['succeeded','failed'].includes(pipelines.get(run.id).state)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));run=pipelines.get(run.id);expect(run.state).toBe('succeeded');expect(await readFile(join(directory,'method-result.txt'),'utf8')).toBe('42');expect(run.attempts.map(attempt=>attempt.methodReviews?.[0].reviewRevision)).toEqual([2,4]);expect(pipelines.store.definition(definition.id).references[0]).toEqual(reference)
  },30000)
  it.skipIf(!rAvailable)('pins the same reviewed method in an actual R Pipeline without starting Python',async()=>{
    const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method('lab.r-method')),'import-r','user:workbench');await methods.review({id:draft.id,revision:1,operationId:'publish-r',action:'publish',note:'Reviewed R fixture scope'})
    const pipelines=await runtime.pipelines(directory);const definition=pipelines.define({title:'Reviewed R run',language:'r',references:[methods.reference(draft.id)],steps:[{id:'r',code:'value <- 40\nprint(value + 2)'}]});let run=pipelines.start(definition.id,'r-method-run');const deadline=Date.now()+15000;while(['preparing','running'].includes(run.state)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));run=pipelines.get(run.id)}expect(run.state).toBe('succeeded');expect(run.attempts[0].methodReviews?.[0].reviewRevision).toBe(2);const receipt=await pipelines.execution(run.id,run.attempts[0].executionId!);expect(receipt.language).toBe('r');expect(receipt.output).toContain('42');expect((await runtime.project(directory)).kernelState().state).toBe('cold')
  },30000)
  it('rechecks policy after actual Python startup and immediately before dispatch, so revoked code has no side effect',async()=>{
    const methods=await runtime.methods(directory);const [draft]=await methods.importPack(pack(method()),'import','user:workbench');await methods.review({id:draft.id,revision:1,operationId:'publish',action:'publish',note:'Reviewed'});const reference=methods.reference(draft.id)
    const worker=await ScienceService.open(join(directory,'isolated'),process.env.OMICOS_SCIENCE_TEST_PYTHON||'python3');workers.push(worker)
    const job=await worker.submit('from pathlib import Path\nPath("must-not-run.txt").write_text("bad")','revoked-during-startup','policy-test',undefined,()=>{methods.validateReferences([reference])})
    await methods.review({id:draft.id,revision:2,operationId:'withdraw',action:'withdraw',note:'Withdrawn while startup is pending'});const stopped=await settled(worker,job.id);expect(stopped.state).toBe('interrupted');expect(stopped.error).toContain('code was not executed');await expect(stat(join(worker.workspace,'must-not-run.txt'))).rejects.toMatchObject({code:'ENOENT'})
    const final=await worker.submit('from pathlib import Path\nPath("must-not-dispatch.txt").write_text("bad")','last-dispatch-check','policy-test',undefined,dispatch=>{if(dispatch)throw new Error('Final dispatch denied')});expect((await settled(worker,final.id)).state).toBe('interrupted');await expect(stat(join(worker.workspace,'must-not-dispatch.txt'))).rejects.toMatchObject({code:'ENOENT'})
  },30000)
})
