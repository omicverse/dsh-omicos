import { inspectEnvironment } from '../src/oss/environment.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { normalizeEnvironmentInstall } from '../src/oss/managed-environments.js'
import type { ManagedEnvironments } from '../src/oss/managed-environments.js'
import type { ManagedPythonEnvironment } from '../src/oss/environment-types.js'
const execute = promisify(execFile)
const python = process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3'
let directory: string; let runtime: OssRuntime
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oss-envs-'));runtime=await OssRuntime.open({stateDir:join(directory,'state'),python});await runtime.project(directory)})
afterEach(async()=>{vi.unstubAllEnvs();await runtime.dispose();await rm(directory,{recursive:true,force:true})})
async function terminal(environments:ManagedEnvironments,id:string):Promise<ManagedPythonEnvironment>{const deadline=Date.now()+30000;while(Date.now()<deadline){const record=environments.get(id);if(!['preparing','installing','verifying'].includes(record.state))return record;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Environment install did not finish')}
async function wheel():Promise<string>{await mkdir(join(directory,'wheels'));const file=join(directory,'wheels','tinyfixture-1.0.0-py3-none-any.whl');await execute(python,['-I','-c',`import sys,zipfile\nfiles={'tinyfixture/__init__.py':'VALUE = 73\\n','tinyfixture-1.0.0.dist-info/METADATA':'Metadata-Version: 2.1\\nName: tinyfixture\\nVersion: 1.0.0\\n','tinyfixture-1.0.0.dist-info/WHEEL':'Wheel-Version: 1.0\\nGenerator: oss-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}\nfiles['tinyfixture-1.0.0.dist-info/RECORD']=''.join(name+',,\\n' for name in files)+'tinyfixture-1.0.0.dist-info/RECORD,,\\n'\nwith zipfile.ZipFile(sys.argv[1],'w') as archive:\n for name,content in files.items(): archive.writestr(name,content)`,file]);return createHash('sha256').update(await readFile(file)).digest('hex')}
describe('explicit managed Python environment provisioning',()=>{
  it('rejects options, URLs, loose versions, missing hashes, duplicate normalized names and oversized locks',()=>{
    const valid={operationId:'test',title:'Test',packages:[{name:'tiny_fixture',version:'1.0.0',sha256:['A'.repeat(64)]}]}
    expect(normalizeEnvironmentInstall(valid).packages[0]).toEqual({name:'tiny-fixture',version:'1.0.0',sha256:['a'.repeat(64)]})
    for(const value of [{...valid,packages:[{...valid.packages[0],version:'>=1'}]},{...valid,packages:[{...valid.packages[0],name:'--index-url'}]},{...valid,packages:[{...valid.packages[0],sha256:[]}]},{...valid,packages:[...valid.packages,{...valid.packages[0],name:'tiny-fixture'}]},{...valid,packages:Array.from({length:201},()=>valid.packages[0])}])expect(()=>normalizeEnvironmentInstall(value)).toThrow()
  })
  it('installs a real hash-verified offline wheel, keeps the live namespace and applies next-start selection/rollback',async()=>{
    const digest=await wheel();const environments=await runtime.managedEnvironments(directory);const request={operationId:'offline',title:'Offline scientific fixture',wheelDirectory:'wheels',packages:[{name:'tinyfixture',version:'1.0.0',sha256:[digest]}]}
    const project=await runtime.project(directory);const initial=await project.submit('existing_value = 42','before-install','test');while(['queued','running'].includes(project.get(initial.id)!.state))await new Promise(resolve=>setTimeout(resolve,20))
    const first=environments.start(request);expect(environments.start(request).id).toBe(first.id);expect(()=>environments.start({...request,operationId:'other'})).toThrow(/finishing/)
    await expect(environments.select({operationId:'too-soon',revision:1,environmentId:first.id})).rejects.toThrow(/finish/)
    const ready=await terminal(environments,first.id);expect(ready.state,ready.error).toBe('ready');expect(ready.installed?.tinyfixture).toBe('1.0.0');expect(ready.manifestSha256).toMatch(/^[a-f0-9]{64}$/);await expect(environments.removePartial(ready.id)).rejects.toThrow(/Only inactive/)
    const selection={operationId:'select',revision:1,environmentId:ready.id};expect((await environments.select(selection)).environmentId).toBe(ready.id);expect((await environments.select(selection)).revision).toBe(2)
    expect(project.python).toBe(python);expect(project.snapshot().variables.find(item=>item.name==='existing_value')?.preview).toBe('42')
    expect(()=>environments.start({...request,title:'Changed'})).toThrow(/another request/)
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python});const restarted=await runtime.project(directory);expect(restarted.python).toBe(ready.interpreter);expect(restarted.executionUnavailable).toBeUndefined()
    await mkdir(join(directory,'host-only'));await writeFile(join(directory,'host-only','unwanted_host_module.py'),'VALUE = 999\n');vi.stubEnv('PYTHONPATH',join(directory,'host-only'))
    const installed=await restarted.submit('import tinyfixture, importlib.util\nassert importlib.util.find_spec("unwanted_host_module") is None\nprint(tinyfixture.VALUE)','after-restart','test');while(['queued','running'].includes(restarted.get(installed.id)!.state))await new Promise(resolve=>setTimeout(resolve,20));expect(restarted.get(installed.id)?.output.trim()).toBe('73');expect(restarted.get(installed.id)?.environment?.isolated).toBe(true)
    expect((await inspectEnvironment(restarted.python,restarted.usesIsolatedPython)).isolated).toBe(true)
    const pipelines=await runtime.pipelines(directory);const pinned=pipelines.define({title:'Managed Pipeline',language:'python',steps:[{id:'s',code:'import tinyfixture, importlib.util\nassert importlib.util.find_spec("unwanted_host_module") is None\nprint(tinyfixture.VALUE)'}]});let run=pipelines.start(pinned.id,'managed-pipeline');const deadline=Date.now()+12000;while(['preparing','running'].includes(run.state)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));run=pipelines.get(run.id)}expect(run.state).toBe('succeeded');expect((await pipelines.execution(run.id,run.attempts[0].executionId!)).environment?.isolated).toBe(true)
    vi.unstubAllEnvs()
    const manager=await runtime.managedEnvironments(directory);expect((await manager.selectedInterpreter())).toBe(ready.interpreter)
    await manager.select({operationId:'rollback',revision:2,environmentId:null});expect(restarted.python).toBe(ready.interpreter);expect(manager.selectionHistory().entries.map(item=>item.environmentId)).toEqual([null,ready.id,null])
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python});expect((await runtime.project(directory)).python).toBe(python);expect((await runtime.managedEnvironments(directory)).start(request).id).toBe(first.id)
  },60000)
  it('fails closed on a bad wheel hash and detects environment changes before selection/startup without silently falling back',async()=>{
    const digest=await wheel();let environments=await runtime.managedEnvironments(directory)
    const bad=environments.start({operationId:'bad-hash',title:'Bad hash',wheelDirectory:'wheels',packages:[{name:'tinyfixture',version:'1.0.0',sha256:['0'.repeat(64)]}]});const failed=await terminal(environments,bad.id);expect(failed.state).toBe('failed');expect(failed.error).toMatch(/hash|HASH/);expect(environments.selection().environmentId).toBeNull()
    await expect(environments.select({operationId:'bad-select',revision:1,environmentId:failed.id})).rejects.toThrow(/ready/)
    const record=environments.start({operationId:'good',title:'Good',wheelDirectory:'wheels',packages:[{name:'tinyfixture',version:'1.0.0',sha256:[digest]}]});const ready=await terminal(environments,record.id);expect(ready.state,ready.error).toBe('ready')
    await environments.select({operationId:'select',revision:1,environmentId:ready.id})
    const version=ready.pythonVersion!.split('.').slice(0,2).join('.');const marker=join(directory,'site-hook-must-not-run')
    await writeFile(join(ready.interpreter,'..','..','lib',`python${version}`,'site-packages','injected.pth'),`import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text('executed')\n`)

    await expect(environments.select({operationId:'tampered',revision:2,environmentId:ready.id})).rejects.toThrow(/changed/)
    await expect(stat(marker)).rejects.toMatchObject({code:'ENOENT'})
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python});const project=await runtime.project(directory);expect(project.executionUnavailable).toMatch(/changed/)
    await expect(project.submit('print("must not run")','blocked','test')).rejects.toThrow(/unavailable/);expect(project.snapshot().executions).toEqual([])
    const pipelines=await runtime.pipelines(directory);const pinned=pipelines.define({title:'No fallback',language:'python',steps:[{id:'s',code:'print(42)'}]});expect(()=>pipelines.start(pinned.id,'must-not-start')).toThrow(/unavailable/)
    environments=await runtime.managedEnvironments(directory);await environments.select({operationId:'rollback',revision:2,environmentId:null});expect(project.executionUnavailable).toBeTruthy()
  },60000)
  it('rejects offline HTML files, escaped paths and symlinked wheel entries before creating a Python environment',async()=>{
    const environments=await runtime.managedEnvironments(directory)
    await writeFile(join(directory,'wheels.html'),'<a href="https://unrequested.invalid/package.whl">package</a>')
    await mkdir(join(directory,'links'));await symlink(join(directory,'wheels.html'),join(directory,'links','package.whl'))
    for(const [index,path] of ['wheels.html','../outside','links'].entries()){
      const record=environments.start({operationId:`invalid-path-${index}`,title:'Invalid offline source',packages:[],wheelDirectory:path});expect((await terminal(environments,record.id)).state).toBe('failed')
      await expect(stat(join(record.interpreter,'..','..','pyvenv.cfg'))).rejects.toMatchObject({code:'ENOENT'})
    }
    expect((await runtime.project(directory)).kernelState().state).toBe('cold');expect(environments.selection().environmentId).toBeNull()
  })
  it('cancels an actual venv creator and records Host shutdown as interruption, without selecting partial environments',async()=>{
    const environments=await runtime.managedEnvironments(directory);const first=environments.start({operationId:'cancel',title:'Canceled',packages:[]})
    const config=join(first.interpreter,'..','..','pyvenv.cfg');const deadline=Date.now()+10000;while(Date.now()<deadline){try{await stat(config);break}catch{}await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await environments.cancel(first.id)).state).toBe('canceled');expect(environments.selection().environmentId).toBeNull();expect((await environments.removePartial(first.id)).state).toBe('removed');expect((await environments.removePartial(first.id)).state).toBe('removed');expect(environments.start({operationId:'cancel',title:'Canceled',packages:[]}).state).toBe('removed');await expect(stat(join(first.interpreter,'..','..'))).rejects.toMatchObject({code:'ENOENT'})
    const next=environments.start({operationId:'shutdown',title:'Interrupted',packages:[]});await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python});const recovered=await runtime.managedEnvironments(directory);expect(recovered.get(next.id).state).toBe('interrupted');expect(recovered.start({operationId:'shutdown',title:'Interrupted',packages:[]}).id).toBe(next.id)
    expect((await runtime.project(directory)).kernelState().state).toBe('cold')
  },60000)
})
