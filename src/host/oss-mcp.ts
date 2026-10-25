import type {Context,Fiber} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import type {OssRuntime} from '../oss/runtime.js'
import {McpConnectionError,type McpConnectionRecord,type McpHostBridge,type McpHostStatus,type McpSecretReference} from '../oss/mcp-types.js'
import {sessionCwdOf} from './dsh-compat.js'

type Live = {record:McpConnectionRecord;phase:'starting'|'registered'|'failed'|'stopping';fiber?:Fiber;ready:Promise<void>;diagnostic?:string;stopped:boolean}
type Attachment = {agent:Agent;workspace:string;connections:Map<string,Live>;queue:Promise<void>;closed:boolean;removeApproval:()=>void}
const RESOURCE_TOOLS=new Set(['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])
const SCOPE='Managed MCP instances belong to concrete OmicOS Scientist agents in this project. Registered means plugin activation completed, not proof of current transport health; visible tools reflect the current Harness generation. Calls require Harness approval. Profile-owned MCP servers are outside this manager.'

/** Reuses the optional published Harness plugin; never imports or implements another MCP SDK. */
export class HarnessProjectMcp implements McpHostBridge {
  private agents=new Map<Agent,Attachment>();private closing=false
  private plugin?:Promise<typeof import('@deepseek-ai/dsh-mcp-client')>
  constructor(private runtime:Promise<OssRuntime>,private workspaceOverride:string,private allowedEnvironment:readonly string[]){}
  private load(){if(this.plugin)return this.plugin;const pending=(async()=>{
    const require=createRequire(import.meta.url)
    // The private transport/lifecycle behavior was verified against this exact public release.
    const manifest=JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-mcp-client/package.json'),'utf8')) as {version:string}
    if(manifest.version!=='0.2.1-rc.3')throw new McpConnectionError(409,'Install optional @deepseek-ai/dsh-mcp-client@0.2.1-rc.3 in the Harness profile')
    return import('@deepseek-ai/dsh-mcp-client')
  })();this.plugin=pending;void pending.catch(()=>{if(this.plugin===pending)this.plugin=undefined});return pending}
  private values(refs:Record<string,McpSecretReference>){return Object.fromEntries(Object.entries(refs).map(([name,ref])=>{
    if(!this.allowedEnvironment.includes(ref.environment))throw new McpConnectionError(409,`Host has not allowed credential environment name ${ref.environment}`)
    const value=process.env[ref.environment]
    if(!value||value.length>16000||/[\r\n\0]/.test(value))throw new McpConnectionError(409,`Host credential environment ${ref.environment} is missing or invalid`)
    return [name,`${ref.prefix||''}${value}`]
  }))}
  async attach(agent:Agent):Promise<void>{
    if(this.closing||this.agents.has(agent))return
    const workspace=this.workspaceOverride||sessionCwdOf({agent})
    if(!workspace)return
    const runtime=await this.runtime;const project=await runtime.project(workspace)
    if(this.closing||this.agents.has(agent))return
    const item:Attachment={agent,workspace:project.workspace,connections:new Map(),queue:Promise.resolve(),closed:false,removeApproval:()=>{}}
    this.agents.set(agent,item)
    try{
      item.removeApproval=agent.ctx.on('tools/pre-execute',async(exec,next)=>{
        const decision=await next();if(decision.kind!=='allow'&&decision.kind!=='ask')return decision
        const record=[...item.connections.values()].find(live=>exec.name.startsWith(`mcp__${live.record.config.serverName}__`)||(RESOURCE_TOOLS.has(exec.name)&&(exec.arguments as {server?:string})?.server===live.record.config.serverName))
        if(!record)return decision
        const registry=await runtime.mcpConnections(item.workspace);const current=registry.get(record.record.id)
        if(item.closed||record.stopped||!registry.authorized(current)||current.revision!==record.record.revision)return {kind:'deny',reason:'Managed MCP connection changed or was disabled; reload its project diagnostics before retrying'}
        if(decision.kind==='ask')return decision
        return {kind:'ask',reason:`OmicOS MCP server ${current.config.serverName} requires approval: ${exec.name}. Arguments/resources may be disclosed to this server.\n${JSON.stringify(exec.arguments).slice(0,4000)}`}
      })
      agent.ctx.effect(()=>()=>this.detach(agent),'omicos: project MCP attachment')
      await this.sync(item)
    }catch(error){await this.detach(agent);throw error}
  }
  /** Rebind retained agents after Host replacement and await their first tool projection.
   * Cancellation stops this wait; the authorized transport remains Agent-owned.
   * Returns whether pre-collected tools/instructions need a fresh prompt assembly.
   */
  async prepare(agent:Agent,signal?:AbortSignal):Promise<boolean>{
    const schema=()=>JSON.stringify((agent.ctx.get('tools')?.schemas(agent)||[]).filter(tool=>tool.name.startsWith('mcp__')||RESOURCE_TOOLS.has(tool.name)))
    const before=schema()
    const existing=this.agents.get(agent)
    const projecting=!existing||[...existing.connections.values()].some(live=>live.phase==='starting')
    signal?.throwIfAborted();await this.attach(agent);signal?.throwIfAborted()
    const item=this.agents.get(agent);if(!item||item.closed||this.closing)return false
    const ready=item.queue.then(()=>Promise.all([...item.connections.values()].map(live=>live.ready))).then(()=>{})
    if(!signal){await ready;return (projecting&&item.connections.size>0)||before!==schema()}
    await new Promise<void>((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason||new Error('MCP context preparation canceled'))};const cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});ready.then(()=>{cleanup();resolve()},error=>{cleanup();reject(error)});if(signal.aborted)abort()})
    signal.throwIfAborted();return (projecting&&item.connections.size>0)||before!==schema()
  }
  /** Logical connection projection, not SDK transport-health or authorization proof. */
  contextVersion(agent:Agent):string{return JSON.stringify([...(this.agents.get(agent)?.connections.values()||[])].map(live=>[live.record.id,live.record.revision,live.phase]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))}
  private async start(item:Attachment,live:Live):Promise<void>{
    try{
      const plugin=await this.load()
      if(item.closed||live.stopped)return
      const registry=await (await this.runtime).mcpConnections(item.workspace);const current=registry.get(live.record.id)
      if(!registry.authorized(current)||current.revision!==live.record.revision)return
      const source=current.config
      const base={failOnStartupError:true,reconnect:{enabled:true,initialDelayMs:1000,maxDelayMs:30000,maxAttempts:5}}
      const config:import('@deepseek-ai/dsh-mcp-client').Config=source.transport==='stdio'?{...source,...base,cwd:item.workspace,env:this.values(source.env)}:{...source,...base,headers:this.values(source.headers)}
      // Keep the actual thenable fiber before awaiting startup, so stop can cancel a pending SDK negotiation.
      const fiber=item.agent.ctx.plugin(plugin,config);live.fiber=fiber
      await fiber
      if(!live.stopped&&!item.closed)live.phase='registered'
    }catch(error){
      if(!live.stopped&&!item.closed){live.phase='failed';live.diagnostic=error instanceof McpConnectionError?error.message:'Harness MCP activation failed. Check the optional rc.3 plugin installation and Host logs; no connection health is inferred.'}
    }
  }
  private async stop(live:Live){live.stopped=true;live.phase='stopping';if(live.fiber)await live.fiber.dispose();await live.ready}
  private sync(item:Attachment):Promise<void>{
    const task=item.queue.then(async()=>{
      if(item.closed||this.closing)return
      const registry=await (await this.runtime).mcpConnections(item.workspace)
      const desired=registry.list().connections.filter(record=>registry.authorized(record))
      for(const [id,live] of item.connections){if(!desired.some(record=>record.id===id&&record.revision===live.record.revision)){await this.stop(live);if(item.connections.get(id)===live)item.connections.delete(id)}}
      if(item.closed||this.closing)return
      for(const record of desired){
        if(item.connections.has(record.id))continue
        const live:Live={record,phase:'starting',ready:Promise.resolve(),stopped:false}
        item.connections.set(record.id,live);live.ready=this.start(item,live)
      }
    });item.queue=task.catch(()=>{});return task
  }
  async reconcile(workspace:string):Promise<void>{await Promise.all([...this.agents.values()].filter(item=>item.workspace===workspace).map(item=>this.sync(item)))}
  async snapshot(workspace:string):Promise<McpHostStatus>{
    return {available:!this.closing,credentialEnvironmentNames:[...this.allowedEnvironment],agents:[...this.agents.values()].filter(item=>item.workspace===workspace&&!item.closed).map(item=>({sessionId:String(item.agent.id),connections:[...item.connections.values()].map(live=>({id:live.record.id,revision:live.record.revision,serverName:live.record.config.serverName,phase:live.phase,tools:(item.agent.ctx.get('tools')?.schemas(item.agent)||[]).map(tool=>tool.name).filter(name=>name.startsWith(`mcp__${live.record.config.serverName}__`)),...(live.diagnostic?{diagnostic:live.diagnostic}:{})}))})),scope:SCOPE}
  }
  async detach(agent:Agent){const item=this.agents.get(agent);if(!item)return;item.closed=true;this.agents.delete(agent);const stopped=await Promise.allSettled([...item.connections.values()].map(live=>this.stop(live)));await item.queue;if(stopped.every(result=>result.status==='fulfilled')){item.connections.clear();item.removeApproval()}}
  async dispose(){this.closing=true;await Promise.allSettled([...this.agents.keys()].map(agent=>this.detach(agent)))}
}
