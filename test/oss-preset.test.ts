import {createScope,scopeTarget} from '@deepseek-ai/dsh-scope'
import type {Agent} from '@deepseek-ai/dsh-agent'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {fileURLToPath} from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Omicos from '../src/host/index.js'

it('registers and mounts OmicOS Scientist with the real rc.3 preset Loader, without leaking its persona globally', async () => {
  await promisify(execFile)(process.execPath, ['esbuild.host.mjs'], { cwd: new URL('../', import.meta.url) })
  const directory = await mkdtemp(join(tmpdir(), 'omicos-preset-'))
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentPresets, { default: 'omicos' })
    const plugin = await ctx.plugin(Omicos, { workspace: directory, stateDir: join(directory, 'state'), backend: 'oss', upstreamBaseUrl: 'https://auth.omicos.cn', python: 'python3' })
    // Optional injections activate asynchronously; wait for the real registration.
    for (let i = 0; i < 50 && !(await ctx.agentPresets.list()).some(preset => preset.id === 'omicos'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    const roster = await ctx.agentPresets.list()
    expect(roster.find(preset => preset.id === 'omicos')).toBeTruthy()
    const scope = await ctx.agentPresets.acquireScope('omicos')
    try {
      const assembled = await ctx.systemPrompt.assemble({ scope: scope.key })
      expect(JSON.stringify(assembled)).toContain('You are OmicOS')
      expect(JSON.stringify(assembled)).toContain('omicos_scientific_skill')
      const runtime = await ctx.omicosScience.runtime; const project = await runtime.project(directory)
      project.remember('shared', 'GRCh38 {{literal_memory_text}}', 'fixture:researcher')
      const privateNote = project.memory.propose({ title: 'Session secret', text: 'UNRELATED_SESSION_SECRET', kind: 'fact', scope: 'session', sessionId: 'unrelated-session', sources: [{ kind: 'user', ref: 'fixture' }], operationId: 'preset-private' }, { owner: true })
      project.memory.transition({ id: privateNote.id, revision: privateNote.revision, action: 'confirm', operationId: 'preset-private-confirm' }, { owner: true })
      project.memory.propose({ title: 'Pending', text: 'UNCONFIRMED_GUESS', kind: 'fact', scope: 'project', sources: [{ kind: 'user', ref: 'fixture' }], operationId: 'preset-pending' }, { owner: true })
      const contextual = await ctx.systemPrompt.assemble({ scope: scope.key, agent: { id: 'actual-session', session: { header: { cwd: directory } } } } as any)
      const encoded = JSON.stringify(contextual)
      expect(encoded).toContain('GRCh38 {{literal_memory_text}}')
      expect(encoded).not.toContain('UNRELATED_SESSION_SECRET'); expect(encoded).not.toContain('UNCONFIRMED_GUESS')
      const global = JSON.stringify(await ctx.systemPrompt.assemble({ agent: { id: 'actual-session' } } as any))
      expect(global).not.toContain('You are OmicOS'); expect(global).not.toContain('literal_memory_text')
    } finally { await scope[Symbol.asyncDispose]() }
    await plugin.dispose()
    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'omicos')).toBe(false)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 20000)

it('retains a mounted Scientist agent through Host replacement, refreshing memory and rebuilding only its current authorized MCP tools',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'omicos-retained-scientist-')),ctx=new Context();ctx.baseUrl=new URL('../',import.meta.url).href;const eventsPath=join(directory,'mcp-events.jsonl');let agentScope:ReturnType<typeof createScope>|undefined
 const events=async()=>{try{return (await readFile(eventsPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}catch{return []}}
 const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<300;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('Retained Scientist did not reach its expected state')}
 try{
  await ctx.plugin(Loader);await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjections);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(McpResources);await ctx.plugin(AgentPresets,{default:'omicos'})
  const config={workspace:directory,stateDir:join(directory,'state'),backend:'oss' as const,upstreamBaseUrl:'http://127.0.0.1:9',autoStart:false};let plugin=await ctx.plugin(Omicos,config);const first=await ctx.omicosScience.runtime;await until(async()=>(await ctx.agentPresets.list()).some(row=>row.id==='omicos'))
  const project=await first.project(directory);await project.remember('reference','BEFORE_RELOAD_REFERENCE','fixture:owner');const registry=await first.mcpConnections(directory);const saved=await registry.save({operationId:'retained-create',title:'Scoped fixture',note:'Native test fixture only',config:{transport:'stdio',serverName:'retained',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url)),eventsPath],env:{},toolCallTimeoutMs:3000}});await registry.setEnabled({id:saved.id,revision:1,operationId:'retained-enable',enabled:true,note:'Allow this exact local test fixture'})
  const agent={id:'retained-scientist',session:{header:{cwd:directory}}} as unknown as Agent;agentScope=createScope(ctx,agent);Object.assign(agent,{ctx:agentScope.ctx});await ctx.agentPresets.mount(agentScope.ctx,'omicos');await ctx.serial(scopeTarget(agent,agent),'agent/created',{agent,source:'create'} as any)
  await until(async()=>agent.ctx.get('tools')!.schemas(agent).some(tool=>tool.name==='mcp__retained__echo'));const before=await ctx.systemPrompt.assemble({scope:agent,agent});expect(JSON.stringify(before)).toContain('BEFORE_RELOAD_REFERENCE');expect(before.contexts.filter(item=>item.name==='omicos:memory')).toHaveLength(1);expect(ctx.tools.schemas().some(tool=>tool.name==='mcp__retained__echo')).toBe(false)
  let permit=false;ctx.provide('approval',{request:vi.fn(async()=>permit?'allowed-once':'rejected')} as any);const call={agent,signal:new AbortController().signal,name:'mcp__retained__echo',callId:ToolCallId('retained-before'),arguments:{text:'before'}};expect(JSON.stringify(await ctx.tools.execute(call))).toContain('rejected');expect((await events()).some(row=>row.event==='invoked')).toBe(false);permit=true;expect(JSON.stringify(await ctx.tools.execute({...call,callId:ToolCallId('retained-allowed')}))).toContain('before')
  const previousPids=(await events()).filter(row=>row.event==='start').map(row=>row.pid);await plugin.dispose();for(const pid of previousPids)expect(()=>process.kill(pid,0)).toThrow();expect(agent.ctx.get('tools')!.schemas(agent).some(tool=>tool.name==='mcp__retained__echo')).toBe(false);await expect(ctx.systemPrompt.assemble({scope:agent,agent})).rejects.toThrow(/Host service is unavailable/)
  plugin=await ctx.plugin(Omicos,config);const next=await ctx.omicosScience.runtime;expect(next === first).toBe(false);await (await next.project(directory)).remember('reference','AFTER_RELOAD_REFERENCE','fixture:owner')
  const after=await ctx.systemPrompt.assemble({scope:agent,agent});expect(after.tools.some(tool=>tool.name==='mcp__retained__echo')).toBe(true);expect(JSON.stringify(after)).toContain('{{must_stay_literal}}');expect(JSON.stringify(after)).toContain('AFTER_RELOAD_REFERENCE');expect(JSON.stringify(after)).not.toContain('BEFORE_RELOAD_REFERENCE');expect(after.contexts.filter(item=>item.name==='omicos:memory')).toHaveLength(1)
  await until(async()=>agent.ctx.get('tools')!.schemas(agent).some(tool=>tool.name==='mcp__retained__echo'));const afterStartCount=(await events()).filter(row=>row.event==='start').length;expect(afterStartCount).toBeGreaterThan(previousPids.length);expect((await next.mcpHost!.snapshot((await next.project(directory)).workspace)).agents[0].connections).toHaveLength(1);const livePids=(await events()).filter(row=>row.event==='start').filter(row=>{try{process.kill(row.pid,0);return true}catch{return false}});expect(livePids).toHaveLength(1);permit=false;expect(JSON.stringify(await ctx.tools.execute({...call,callId:ToolCallId('retained-denied-after')}))).toContain('rejected');expect((await events()).filter(row=>row.event==='invoked')).toHaveLength(1);permit=true;expect(JSON.stringify(await ctx.tools.execute({...call,callId:ToolCallId('retained-after'),arguments:{text:'after'}}))).toContain('after');expect((await events()).filter(row=>row.event==='invoked')).toHaveLength(2);await ctx.systemPrompt.assemble({scope:agent,agent});expect((await events()).filter(row=>row.event==='start').length).toBe(afterStartCount)
  const current=await next.mcpConnections(directory);const latest=current.get(saved.id);await current.setEnabled({id:saved.id,revision:latest.revision,operationId:'retained-disable',enabled:false,note:'Revoke before another Host reload'});await next.mcpHost!.reconcile((await next.project(directory)).workspace);await plugin.dispose();plugin=await ctx.plugin(Omicos,config);await ctx.omicosScience.runtime;const revoked=await ctx.systemPrompt.assemble({scope:agent,agent});expect(revoked.tools.some(tool=>tool.name==='mcp__retained__echo')).toBe(false);expect(revoked.contexts.filter(item=>item.name==='omicos:memory')).toHaveLength(1);expect((await events()).filter(row=>row.event==='start').length).toBe(afterStartCount)
  const third=await ctx.omicosScience.runtime;const resourcesRegistry=await third.mcpConnections(directory);const disabled=resourcesRegistry.get(saved.id);const resourceDraft=await resourcesRegistry.save({id:disabled.id,revision:disabled.revision,operationId:'retained-resources',title:'Resources-only fixture',note:'Verify instruction-only projection refresh',config:{...disabled.config,args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url)),eventsPath,'--resources-only']} as any});await resourcesRegistry.setEnabled({id:resourceDraft.id,revision:resourceDraft.revision,operationId:'retained-resources-enable',enabled:true,note:'Allow this exact resource fixture'});await third.mcpHost!.reconcile((await third.project(directory)).workspace);const resources=await ctx.systemPrompt.assemble({scope:agent,agent});expect(resources.tools.some(tool=>tool.name==='mcp__retained__echo')).toBe(false);expect(JSON.stringify(resources)).toContain('{{must_stay_literal}}');permit=false;const readCall={...call,name:'read_mcp_resource',callId:ToolCallId('resource-denied'),arguments:{server:'retained',uri:'fixture://paper'}};expect(JSON.stringify(await ctx.tools.execute(readCall))).toContain('rejected');expect((await events()).filter(row=>row.event==='read')).toHaveLength(0);permit=true;expect(JSON.stringify(await ctx.tools.execute({...readCall,callId:ToolCallId('resource-allowed')}))).toContain('Actual project MCP resource');expect((await events()).filter(row=>row.event==='read')).toHaveLength(1)
  const global=JSON.stringify(await ctx.systemPrompt.assemble());expect(global).not.toContain('AFTER_RELOAD_REFERENCE');expect(global).not.toContain('You are OmicOS');expect(ctx.tools.schemas().some(tool=>tool.name==='mcp__retained__echo')).toBe(false);await plugin.dispose()
 }finally{await agentScope?.dispose();await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})}
},20000)
