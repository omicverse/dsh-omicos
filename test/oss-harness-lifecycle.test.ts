import {expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {mkdtemp,readFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as Omicos from '../src/host/index.js'
import {OssRuntime} from '../src/oss/runtime.js'
import {LocalOwnerAuth} from '../src/oss/http-auth.js'
import type {ScienceService} from '../src/oss/science.js'
async function until(check:()=>boolean|Promise<boolean>,message:string){for(let i=0;i<400;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error(message)}
async function settled(service:ScienceService,id:string){await until(()=>!['queued','running'].includes(service.get(id)!.state),'Scientific execution did not finish');return service.get(id)!}

it('unloads and remounts the actual rc.3 Cordis plugin, routes/tools/preset and worker ownership without duplicate registrations or implicit replay',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'omicos-harness-lifecycle-')),workspace=join(directory,'project'),ctx=new Context();ctx.baseUrl=new URL('../',import.meta.url).href
 const external=await OssRuntime.open({stateDir:join(directory,'external-state'),python:process.env.OMICOS_SCIENCE_TEST_PYTHON||'python3'});const independent=await external.project(join(directory,'independent'))
 try{
  await ctx.plugin(Loader);await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjections);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentPresets,{default:'omicos'})
  const config={workspace,stateDir:join(directory,'state'),backend:'oss' as const,python:process.env.OMICOS_SCIENCE_TEST_PYTHON||'python3',autoStart:false,upstreamBaseUrl:'http://127.0.0.1:9'}
  let plugin=await ctx.plugin(Omicos,config);const first=await ctx.omicosScience.runtime;const project=await first.project(workspace)
  await until(async()=>(await ctx.agentPresets.list()).some(item=>item.id==='omicos'),'Preset did not register')
  const toolNames=ctx.tools.schemas().filter(tool=>tool.name.startsWith('omicos_')).map(tool=>tool.name).sort();expect(new Set(toolNames).size).toBe(toolNames.length);expect(toolNames).toContain('omicos_run_python')
  // The real rc.3 HTTP carrier is deliberately added after the plugin. The
  // connection adapter uses the tested standalone owner auth, not a fake allow.
  const auth=new LocalOwnerAuth();ctx.provide('connection',{authorizeIndex:(req:any,res:any)=>auth.authorizePage(req,res),requestRejection:(req:any)=>auth.requestRejection(req)} as any)
  let web=await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});let base=ctx.webServer.getOrigin()
  ctx.webServer.register({kind:'exact',path:'/unrelated',handler:(_req,res)=>{res.end('separate plugin')}})
  const fetchOwner=(path:string)=>fetch(base+path,{headers:{authorization:`Bearer ${auth.launchToken}`}})
  await until(async()=>(await fetchOwner('/omicos/oss/api/session')).status===200,'Deferred route did not mount');expect((await fetch(base+'/omicos/oss/api/session')).status).toBe(401)
  const prep='import os\nvalue = 41\nprint(os.getpid())';const original=await project.submit(prep,'original','fixture');const result=await settled(project,original.id);expect(result.state).toBe('succeeded');const pid=Number(result.output.trim());expect(Number.isInteger(pid)).toBe(true)
  const separate=await independent.submit('import os\nkept=42\nprint(os.getpid())','independent','fixture');const separatePid=Number((await settled(independent,separate.id)).output.trim())
  await project.remember('reload-memory','Remembered through plugin remount','fixture:owner')
  const saved=await (await first.publicationProfiles(workspace)).save({name:'Reload preference',description:'Must survive plugin remount',profile:{dpi:240,attachments:'none'},operationId:'lifecycle-profile'})
  const running=await project.submit('import time\nfrom pathlib import Path\nPath("started.txt").write_text("started")\ntime.sleep(30)\nPath("must-not-finish.txt").write_text("unexpected")','running','fixture')
  await until(async()=>{try{await access(join(workspace,'started.txt'));return true}catch{return false}},'Running worker did not dispatch')
  await plugin.dispose()
  expect(()=>process.kill(pid,0)).toThrow();expect(()=>process.kill(separatePid,0)).not.toThrow();expect((await fetch(base+'/unrelated')).status).toBe(200);expect((await fetchOwner('/omicos/oss/api/session')).status).toBe(404);expect(ctx.tools.schemas().some(tool=>tool.name.startsWith('omicos_'))).toBe(false);expect((await ctx.agentPresets.list()).some(item=>item.id==='omicos')).toBe(false)
  plugin=await ctx.plugin(Omicos,config);const second=await ctx.omicosScience.runtime;const restored=await second.project(workspace)
  await until(async()=>(await ctx.agentPresets.list()).some(item=>item.id==='omicos'),'Preset did not remount');await until(async()=>(await fetchOwner('/omicos/oss/api/session')).status===200,'Route did not remount')
  expect(ctx.tools.schemas().filter(tool=>tool.name.startsWith('omicos_')).map(tool=>tool.name).sort()).toEqual(toolNames);expect(second).not.toBe(first);expect(restored.snapshot().kernel.state).toBe('cold');expect(restored.get(running.id)!.state).toBe('interrupted');expect(restored.get(original.id)).toEqual(result);expect(restored.memories().some(note=>note.text==='Remembered through plugin remount')).toBe(true);expect((await second.publicationProfiles(workspace)).get(saved.id)).toEqual(saved)
  expect((await restored.submit(prep,'original','fixture')).id).toBe(original.id);expect(restored.snapshot().kernel.state).toBe('cold')
  const final=await independent.submit('print(kept)','still-independent','fixture');expect((await settled(independent,final.id)).output.trim()).toBe('42');expect(independent.kernelState().state).toBe('ready')
  await expect(readFile(join(workspace,'must-not-finish.txt'))).rejects.toMatchObject({code:'ENOENT'})
  const prepared=await restored.submit('import os\nretained_after_web_reload=7\nprint(os.getpid())','web-reload','fixture');const newPid=Number((await settled(restored,prepared.id)).output.trim());const listeners=restored.listenerCount('shutdown');const projectId=(await second.list())[0].id;const events=await fetchOwner(`/omicos/oss/api/project/${projectId}/events?after=${restored.eventCursor}`);expect(events.headers.get('content-type')).toContain('text/event-stream');expect(restored.listenerCount('shutdown')).toBe(listeners+1);await web.dispose();await until(()=>restored.listenerCount('shutdown')===listeners,'SSE subscription survived WebServer teardown');await events.body?.cancel().catch(()=>{});expect(()=>process.kill(newPid,0)).not.toThrow();expect(await ctx.omicosScience.runtime).toBe(second);web=await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});base=ctx.webServer.getOrigin();await until(async()=>(await fetchOwner('/omicos/oss/api/session')).status===200,'Route did not follow replaced WebServer');const check=await restored.submit('print(retained_after_web_reload)','web-retained','fixture');expect((await settled(restored,check.id)).output.trim()).toBe('7');expect(ctx.tools.schemas().filter(tool=>tool.name.startsWith('omicos_')).map(tool=>tool.name).sort()).toEqual(toolNames)
  await plugin.dispose();expect(()=>process.kill(newPid,0)).toThrow();expect((await fetchOwner('/omicos/oss/api/session')).status).toBe(404)
 }finally{await ctx.fiber.dispose();await external.dispose();await rm(directory,{recursive:true,force:true})}
},30000)

it('awaits startup already in flight before releasing project ownership and permits a clean remount',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'omicos-startup-unload-')),ctx=new Context();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const original=OssRuntime.open.bind(OssRuntime);let initialized=false;const spy=vi.spyOn(OssRuntime,'open').mockImplementationOnce(async options=>{const service=await original(options);initialized=true;await gate;return service})
 try{await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);const config={backend:'oss' as const,workspace:join(directory,'project'),stateDir:join(directory,'state'),autoStart:false,upstreamBaseUrl:'http://127.0.0.1:9'};const plugin=await ctx.plugin(Omicos,config);const pending=ctx.omicosScience.runtime;await until(()=>initialized,'Runtime did not enter startup');let finished=false;const teardown=plugin.dispose().then(()=>{finished=true});await new Promise(resolve=>setTimeout(resolve,30));expect(finished).toBe(false);release();await teardown;const previous=await pending;await expect(previous.project(config.workspace)).rejects.toThrow(/shutting down/);spy.mockRestore();const mounted=await ctx.plugin(Omicos,config);const current=await ctx.omicosScience.runtime;expect((await current.project(config.workspace)).kernelState().state).toBe('cold');await mounted.dispose()
 }finally{release();spy.mockRestore();await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})}
},15000)
