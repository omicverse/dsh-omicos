import {expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {OssRuntime} from '../src/oss/runtime.js'
import {HarnessProjectMcp} from '../src/host/oss-mcp.js'
import type {McpConnectionRecord} from '../src/oss/mcp-types.js'
const fixture=fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url))
const pause=()=>new Promise(resolve=>setTimeout(resolve,20))
async function until(test:()=>Promise<boolean>){for(let index=0;index<400;index++){if(await test())return;await pause()}throw new Error('Actual MCP fixture did not reach its expected state')}
async function events(path:string){try{return (await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}catch{return []}}
async function setup(){const directory=await mkdtemp(join(tmpdir(),'omicos-mcp-host-'));const runtime=await OssRuntime.open({stateDir:join(directory,'state')});const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(McpResources);const bridge=new HarnessProjectMcp(Promise.resolve(runtime),'',['OMICOS_MCP_FIXTURE_TOKEN']);runtime.mcpHost=bridge;return {directory,runtime,ctx,bridge}}
function agent(ctx:Context,id:string,workspace:string){const value={id,session:{header:{cwd:workspace}}} as unknown as Agent;const scope=createScope(ctx,value);Object.assign(value,{ctx:scope.ctx});return {value,scope}}
async function create(runtime:OssRuntime,workspace:string,eventsPath:string,releasePath?:string){const registry=await runtime.mcpConnections(workspace);const draft=await registry.save({operationId:'create',title:'Local fixture',note:'Fixture only',config:{transport:'stdio',serverName:'research',command:process.execPath,args:[fixture,eventsPath,...releasePath?[releasePath]:[]],env:{FIXTURE_TOKEN:{environment:'OMICOS_MCP_FIXTURE_TOKEN'}},toolCallTimeoutMs:5000}});return registry.setEnabled({id:draft.id,revision:1,operationId:'enable',enabled:true,note:'Authorize fixture attachment'})}

it('reuses the actual published Harness stdio MCP plugin, scopes tools/resources and enforces approval before any call',async()=>{
  const {directory,runtime,ctx,bridge}=await setup();const old=process.env.OMICOS_MCP_FIXTURE_TOKEN;process.env.OMICOS_MCP_FIXTURE_TOKEN='synthetic-private-mcp-token'
  const left=await runtime.project(join(directory,'left'));const right=await runtime.project(join(directory,'right'));const first=agent(ctx,'left-session',left.workspace),second=agent(ctx,'right-session',right.workspace);const log=join(directory,'events.jsonl')
  try{
    const record=await create(runtime,left.workspace,log)
    await bridge.attach(first.value);await bridge.attach(second.value)
    await until(async()=>(await bridge.snapshot(left.workspace)).agents[0]?.connections[0]?.phase==='registered')
    expect(first.scope.ctx.get('tools')!.schemas(first.value).some(tool=>tool.name==='mcp__research__echo')).toBe(true)
    expect(ctx.tools.schemas().some(tool=>tool.name==='mcp__research__echo')).toBe(false)
    expect(second.scope.ctx.get('tools')!.schemas(second.value).some(tool=>tool.name==='mcp__research__echo')).toBe(false)
    const request={agent:first.value,signal:new AbortController().signal,callId:ToolCallId('denied'),name:'mcp__research__echo',arguments:{text:'no approval'}}
    expect(JSON.stringify(await ctx.tools.execute(request))).toMatch(/approval|denied/i)
    expect((await events(log)).some(item=>item.event==='invoked')).toBe(false)
    ctx.provide('approval',{request:vi.fn(async()=>'allowed-once')} as never)
    const result=await ctx.tools.execute({...request,callId:ToolCallId('allowed'),arguments:{text:'actual echo'}})
    expect(JSON.stringify(result)).toContain('actual echo; credential=true')
    expect((await events(log)).filter(item=>item.event==='invoked')).toHaveLength(1)
    const resource=await ctx.tools.execute({...request,callId:ToolCallId('resource'),name:'read_mcp_resource',arguments:{server:'research',uri:'fixture://paper'}})
    expect(JSON.stringify(resource)).toContain('Actual project MCP resource')
    const prompt=await ctx.systemPrompt.assemble({scope:first.value,agent:first.value});expect(JSON.stringify(prompt)).toContain('{{must_stay_literal}}')
    expect(JSON.stringify(await bridge.snapshot(left.workspace))).not.toContain('synthetic-private-mcp-token')
    const registry=await runtime.mcpConnections(left.workspace)
    const removeOtherAsk=first.scope.ctx.on('tools/pre-execute',async(_exec,next)=>{const decision=await next();return decision.kind==='allow'?{kind:'ask',reason:'Existing Harness approval policy'}:decision})
    const disabled=await registry.setEnabled({id:record.id,revision:record.revision,operationId:'disable',enabled:false,note:'Stop project access'})
    // The dispatch guard reads the current durable decision even before reconciliation removes registrations.
    expect(JSON.stringify(await ctx.tools.execute({...request,callId:ToolCallId('disabled')}))).toContain('disabled')
    expect((await events(log)).filter(item=>item.event==='invoked')).toHaveLength(1)
    removeOtherAsk()
    await bridge.reconcile(left.workspace)
    expect(first.scope.ctx.get('tools')!.schemas(first.value).some(tool=>tool.name==='mcp__research__echo')).toBe(false)
    expect((await bridge.snapshot(left.workspace)).agents[0].connections).toEqual([])
    expect((await registry.setEnabled({id:record.id,revision:1,operationId:'enable',enabled:true,note:'Authorize fixture attachment'})).revision).toBe(disabled.revision)
    const restored=await registry.setEnabled({id:record.id,revision:disabled.revision,operationId:'restore',enabled:true,note:'Explicit fresh attachment'})
    await bridge.reconcile(left.workspace);await until(async()=>(await bridge.snapshot(left.workspace)).agents[0]?.connections[0]?.phase==='registered')
    const beforeReconnect=(await events(log)).filter(item=>item.event==='start').length
    const reconnect={id:record.id,revision:restored.revision,operationId:'restart-once',note:'Explicitly replace the MCP connection'}
    await registry.reconnect(reconnect);await bridge.reconcile(left.workspace);await until(async()=>(await bridge.snapshot(left.workspace)).agents[0]?.connections[0]?.phase==='registered')
    const afterReconnect=(await events(log)).filter(item=>item.event==='start').length;expect(afterReconnect).toBeGreaterThan(beforeReconnect)
    await registry.reconnect(reconnect);await bridge.reconcile(left.workspace)
    expect((await events(log)).filter(item=>item.event==='start')).toHaveLength(afterReconnect)
    // Runtime shutdown itself owns MCP teardown, not only the outer Host plugin.
    await runtime.dispose()
    for(const item of (await events(log)).filter(item=>item.event==='start'))expect(()=>process.kill(item.pid,0)).toThrow()
  }finally{await bridge.dispose();await first.scope.dispose();await second.scope.dispose();await ctx.fiber.dispose();await runtime.dispose();if(old===undefined)delete process.env.OMICOS_MCP_FIXTURE_TOKEN;else process.env.OMICOS_MCP_FIXTURE_TOKEN=old;await rm(directory,{recursive:true,force:true})}
},20000)

it('fences a delayed optional-plugin import when its concrete Scientist is disposed before startup',async()=>{
  const {directory,runtime,ctx,bridge}=await setup();const project=await runtime.project(join(directory,'project'));const scoped=agent(ctx,'late-import',project.workspace);const log=join(directory,'never-started.jsonl')
  let release!:(plugin:typeof import('@deepseek-ai/dsh-mcp-client'))=>void
  const gate=new Promise<typeof import('@deepseek-ai/dsh-mcp-client')>(resolve=>{release=resolve})
  const load=vi.spyOn(bridge as any,'load').mockReturnValue(gate)
  try{
    const registry=await runtime.mcpConnections(project.workspace)
    const record=await registry.save({operationId:'late-create',title:'Delayed plugin',note:'Lifecycle fixture',config:{transport:'stdio',serverName:'delayed',command:process.execPath,args:[fixture,log],env:{},toolCallTimeoutMs:5000}})
    await registry.setEnabled({id:record.id,revision:1,operationId:'late-enable',enabled:true,note:'Explicit fixture authorization'})
    await bridge.attach(scoped.value);expect(load).toHaveBeenCalledOnce()
    const closing=runtime.dispose();release(await import('@deepseek-ai/dsh-mcp-client'));await closing
    expect(await events(log)).toEqual([]);expect((await bridge.snapshot(project.workspace)).agents).toEqual([])
  }finally{load.mockRestore();await bridge.dispose();await scoped.scope.dispose();await ctx.fiber.dispose();await runtime.dispose();await rm(directory,{recursive:true,force:true})}
})

it('uses actual Harness Streamable HTTP with explicit Host credential binding and approved external calls',async()=>{
  const {directory,runtime,ctx,bridge}=await setup();const old=process.env.OMICOS_MCP_FIXTURE_TOKEN;process.env.OMICOS_MCP_FIXTURE_TOKEN='synthetic-http-credential'
  const requests:Array<{method:string;authorized:boolean}>=[]
  const server=createServer(async(request,response)=>{
    if(request.method!=='POST'){response.writeHead(request.method==='DELETE'?204:405);response.end();return}
    const chunks=[];for await(const chunk of request)chunks.push(chunk)
    const rpc=JSON.parse(Buffer.concat(chunks).toString());requests.push({method:rpc.method,authorized:request.headers.authorization==='Bearer synthetic-http-credential'})
    if(rpc.id===undefined){response.writeHead(202);response.end();return}
    response.setHeader('content-type','application/json')
    if(rpc.method==='server/discover'){response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Legacy HTTP fixture'}}));return}
    const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'HTTP fixture',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'search',description:'Local HTTP fixture search',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]}:rpc.method==='tools/call'?{content:[{type:'text',text:`HTTP research fixture: ${rpc.params.arguments.query}`}]}:{}
    response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const project=await runtime.project(join(directory,'project'));const scoped=agent(ctx,'http-session',project.workspace)
  try{
    const registry=await runtime.mcpConnections(project.workspace)
    const record=await registry.save({operationId:'http-create',title:'HTTP fixture',note:'Local HTTP endpoint',config:{transport:'streamable-http',serverName:'papers',url:`http://127.0.0.1:${(server.address() as any).port}/mcp`,headers:{Authorization:{environment:'OMICOS_MCP_FIXTURE_TOKEN',prefix:'Bearer '}},toolCallTimeoutMs:5000}})
    expect(requests).toEqual([])
    await registry.setEnabled({id:record.id,revision:1,operationId:'http-enable',enabled:true,note:'Permit endpoint contact'})
    await bridge.attach(scoped.value)
    await until(async()=>(await bridge.snapshot(project.workspace)).agents[0]?.connections[0]?.phase==='registered')
    expect(requests.length).toBeGreaterThan(0);expect(requests.every(request=>request.authorized)).toBe(true)
    const call={agent:scoped.value,signal:new AbortController().signal,callId:ToolCallId('http-denied'),name:'mcp__papers__search',arguments:{query:'single-cell atlas'}}
    expect(JSON.stringify(await ctx.tools.execute(call))).toMatch(/approval|denied/i);expect(requests.some(request=>request.method==='tools/call')).toBe(false)
    ctx.provide('approval',{request:async()=>'allowed-once'} as never)
    expect(JSON.stringify(await ctx.tools.execute({...call,callId:ToolCallId('http-approved')}))).toContain('HTTP research fixture: single-cell atlas')
    expect(requests.filter(request=>request.method==='tools/call')).toHaveLength(1)
    expect(JSON.stringify(registry.export(record.id))).not.toContain('synthetic-http-credential')
  }finally{await bridge.dispose();await scoped.scope.dispose();await ctx.fiber.dispose();await runtime.dispose();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()});if(old===undefined)delete process.env.OMICOS_MCP_FIXTURE_TOKEN;else process.env.OMICOS_MCP_FIXTURE_TOKEN=old;await rm(directory,{recursive:true,force:true})}
},20000)

it('cancels a real pending negotiation on disable and does not start late after disposal or expose unapproved Host credentials',async()=>{
  const {directory,runtime,ctx,bridge}=await setup();const old=process.env.OMICOS_MCP_FIXTURE_TOKEN;process.env.OMICOS_MCP_FIXTURE_TOKEN='synthetic-only'
  const project=await runtime.project(join(directory,'project'));const scoped=agent(ctx,'pending-session',project.workspace);const log=join(directory,'events.jsonl')
  try{
    let record=await create(runtime,project.workspace,log,join(directory,'not-released'))
    await bridge.attach(scoped.value)
    await until(async()=>(await events(log)).some(item=>item.event==='server/discover'))
    const registry=await runtime.mcpConnections(project.workspace)
    record=await registry.setEnabled({id:record.id,revision:record.revision,operationId:'disable',enabled:false,note:'Cancel negotiation'})
    await bridge.reconcile(project.workspace)
    for(const item of (await events(log)).filter(item=>item.event==='start'))expect(()=>process.kill(item.pid,0)).toThrow()
    expect((await bridge.snapshot(project.workspace)).agents[0].connections).toEqual([])
    record=await registry.save({id:record.id,revision:record.revision,operationId:'credential-edit',title:record.title,note:'Unapproved secret reference',config:{...record.config,env:{FIXTURE_TOKEN:{environment:'UNAPPROVED_HOST_TOKEN'}}} as any})
    await registry.setEnabled({id:record.id,revision:record.revision,operationId:'reenable',enabled:true,note:'Attempt missing allowlist'})
    await bridge.reconcile(project.workspace)
    await until(async()=>(await bridge.snapshot(project.workspace)).agents[0]?.connections[0]?.phase==='failed')
    expect((await bridge.snapshot(project.workspace)).agents[0].connections[0].diagnostic).toContain('has not allowed')
    expect((await events(log)).filter(item=>item.event==='start')).toHaveLength(1)
    await bridge.dispose();expect((await bridge.snapshot(project.workspace)).agents).toEqual([])
  }finally{await bridge.dispose();await scoped.scope.dispose();await ctx.fiber.dispose();await runtime.dispose();if(old===undefined)delete process.env.OMICOS_MCP_FIXTURE_TOKEN;else process.env.OMICOS_MCP_FIXTURE_TOKEN=old;await rm(directory,{recursive:true,force:true})}
},20000)

it('cancels only context preparation while preserving one Agent-owned negotiating transport, then resumes without duplicate instances',async()=>{
 const {directory,runtime,ctx,bridge}=await setup();const project=await runtime.project(join(directory,'project'));const current=agent(ctx,'preparing-session',project.workspace);const log=join(directory,'events.jsonl'),release=join(directory,'release');const old=process.env.OMICOS_MCP_FIXTURE_TOKEN;process.env.OMICOS_MCP_FIXTURE_TOKEN='synthetic';const signal=new AbortController()
 try{await create(runtime,project.workspace,log,release);const waiting=bridge.prepare(current.value,signal.signal).catch(error=>error);await until(async()=>(await events(log)).some(row=>row.event==='server/discover'));signal.abort();expect(await waiting).toMatchObject({name:'AbortError'});expect((await bridge.snapshot(project.workspace)).agents).toHaveLength(1);await writeFile(release,'allow fixture negotiation');await bridge.prepare(current.value);expect(current.scope.ctx.get('tools')!.schemas(current.value).some(tool=>tool.name==='mcp__research__echo')).toBe(true);const starts=(await events(log)).filter(row=>row.event==='start').length;await bridge.prepare(current.value);expect((await events(log)).filter(row=>row.event==='start')).toHaveLength(starts);await bridge.dispose();for(const row of (await events(log)).filter(row=>row.event==='start'))expect(()=>process.kill(row.pid,0)).toThrow()
 }finally{signal.abort();await bridge.dispose();await current.scope.dispose();await ctx.fiber.dispose();await runtime.dispose();if(old===undefined)delete process.env.OMICOS_MCP_FIXTURE_TOKEN;else process.env.OMICOS_MCP_FIXTURE_TOKEN=old;await rm(directory,{recursive:true,force:true})}
},15000)
