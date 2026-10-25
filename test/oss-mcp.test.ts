import {expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ProjectMcpConnections,normalizeMcpConfig} from '../src/oss/mcp.js'
import type {McpConnectionConfig} from '../src/oss/mcp-types.js'
import {McpAuthorization} from '../src/oss/mcp-authorization.js'
import {OssRuntime} from '../src/oss/runtime.js'

const config:McpConnectionConfig={transport:'stdio',serverName:'research',command:'node',args:['server.mjs'],env:{API_TOKEN:{environment:'OMICOS_TEST_API_TOKEN'}},toolCallTimeoutMs:60000}
async function fixture(){const workspace=await mkdtemp(join(tmpdir(),'omicos-mcp-'));await mkdir(join(workspace,'.omicos-oss'));return workspace}

it('journals disabled project connections, explicit human enablement and immutable revisions without starting servers',async()=>{
  const workspace=await fixture();const authority=await McpAuthorization.open(join(workspace,'host-state'));let service=await ProjectMcpConnections.open(workspace,authority)
  try{
    const input={operationId:'create',title:'Research server',config,note:'Reviewed the local executable and its data access'}
    const first=await service.save(input);expect(first.enabled).toBe(false);expect(first.revision).toBe(1)
    expect((await service.save(input)).id).toBe(first.id)
    await expect(service.save({...input,title:'different'})).rejects.toMatchObject({status:409})
    const decision={id:first.id,revision:1,operationId:'enable',enabled:true,note:'Authorize this project Scientist to attach the server; calls still require approval'}
    const enabled=await service.setEnabled(decision);expect(enabled.enabled).toBe(true);expect(enabled.revision).toBe(2)
    const edited=await service.save({...input,id:first.id,revision:2,operationId:'edit',config:{...config,args:['different.mjs']}})
    expect(edited.enabled).toBe(false);expect(edited.revision).toBe(3)
    expect((await service.setEnabled(decision)).enabled).toBe(false)
    expect(service.get(first.id,2).enabled).toBe(true)
    expect(service.export(first.id,2)).toMatchObject({schema:'omicos.mcp/1',enabled:false,connection:{config}})
    expect(service.history(first.id).revisions.map(item=>item.revision)).toEqual([3,2,1])
    await expect(service.setEnabled({...decision,operationId:'stale'})).rejects.toMatchObject({status:409})
    await expect(service.save({...input,operationId:'duplicate'})).rejects.toMatchObject({status:409})
    await service.dispose();service=await ProjectMcpConnections.open(workspace,authority)
    expect(service.get(first.id).digest).toBe(edited.digest)
    expect((await service.save(input)).revision).toBe(3)
    const bytes=await readFile(join(workspace,'.omicos-oss','mcp.sqlite'));expect(bytes.includes(Buffer.from('OMICOS_TEST_API_TOKEN'))).toBe(true)
  }finally{await service.dispose();authority.dispose();await rm(workspace,{recursive:true,force:true})}
})

it('validates bounded transports and credential references without accepting credential values or loader overrides',()=>{
  expect(normalizeMcpConfig(config)).toEqual(config)
  const http:McpConnectionConfig={transport:'streamable-http',serverName:'papers',url:'http://127.0.0.1:8123/mcp',headers:{Authorization:{environment:'RESEARCH_TOKEN',prefix:'Bearer '}},toolCallTimeoutMs:12000}
  expect(normalizeMcpConfig(http)).toEqual(http)
  for(const url of ['http://example.com/mcp','https://user:pass@example.com/mcp','https://example.com/?token=secret','https://example.com/#secret','file:///etc/passwd']){
    expect(()=>normalizeMcpConfig({...http,url})).toThrow()
  }
  for(const env of [{TOKEN:'secret'},{TOKEN:{environment:'TOKEN',value:'secret'}},{NODE_OPTIONS:{environment:'TOKEN'}},{PATH:{environment:'TOKEN'}},{TOKEN:{environment:'TOKEN',prefix:'secret'}}])expect(()=>normalizeMcpConfig({...config,env:env as any})).toThrow()
  for(const headers of [{Host:{environment:'TOKEN'}},{Authorization:{environment:'TOKEN'},authorization:{environment:'TOKEN'}},{'X-Token\nBad':{environment:'TOKEN'}},{Authorization:{environment:'TOKEN',prefix:'Bearer \r\n'}}])expect(()=>normalizeMcpConfig({...http,headers})).toThrow()
  expect(()=>normalizeMcpConfig({...config,args:Array(101).fill('a')})).toThrow()
  expect(()=>normalizeMcpConfig({...config,args:['\0']})).toThrow()
  expect(()=>normalizeMcpConfig({...config,toolCallTimeoutMs:0})).toThrow()
  for(const serverName of ['invalid namespace','research__child','research_'])expect(()=>normalizeMcpConfig({...config,serverName})).toThrow()
})

it('bounds discovery, enablement and revision pages while retaining stable operation receipts',async()=>{
  const workspace=await fixture();const authority=await McpAuthorization.open(join(workspace,'host-state'));const service=await ProjectMcpConnections.open(workspace,authority)
  try{
    const records=[]
    for(let index=0;index<50;index++)records.push(await service.save({operationId:`create-${index}`,title:`Server ${index}`,config:{...config,serverName:`server-${index}`},note:'Initial configuration'}))
    expect(service.list().connections).toHaveLength(50)
    await expect(service.save({operationId:'overflow',title:'Overflow',config:{...config,serverName:'overflow'},note:'Above bound'})).rejects.toMatchObject({status:409})
    for(const record of records.slice(0,10))await service.setEnabled({id:record.id,revision:record.revision,operationId:`enable-${record.id}`,enabled:true,note:'Explicitly enabled'})
    await expect(service.setEnabled({id:records[10].id,revision:1,operationId:'enable-overflow',enabled:true,note:'Above active bound'})).rejects.toMatchObject({status:409})
    let current=records[49]
    for(let index=0;index<51;index++)current=await service.save({id:current.id,revision:current.revision,operationId:`revision-${index}`,title:'Edited',config:current.config,note:'Versioned edit'})
    const page=service.history(current.id);expect(page.revisions).toHaveLength(50);expect(page.next).toBe(3)
    expect(service.history(current.id,page.next).revisions.map(item=>item.revision)).toEqual([2,1])
    expect(()=>service.history(current.id,0)).toThrow()
  }finally{await service.dispose();authority.dispose();await rm(workspace,{recursive:true,force:true})}
})

it('keeps namespaces and persisted enablement project-local without launching interpreters or sharing other projects',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'omicos-mcp-runtime-'));const runtime=await OssRuntime.open({stateDir:join(directory,'state')})
  try{
    const left=await runtime.project(join(directory,'left')),right=await runtime.project(join(directory,'right'))
    const registry=await runtime.mcpConnections(left.workspace)
    const record=await registry.save({operationId:'first',title:'Left-only',config,note:'Explicit local config'})
    await registry.setEnabled({id:record.id,revision:1,operationId:'enabled',enabled:true,note:'Left project only'})
    expect((await runtime.mcpConnections(right.workspace)).list().connections).toEqual([])
    expect(left.snapshot().executions).toEqual([]);expect(right.snapshot().executions).toEqual([])
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true})}
})

it('requires fresh Host authorization after project copying/rollback and stays revoked when the second database grant fails',async()=>{
  const workspace=await fixture();const authority=await McpAuthorization.open(join(workspace,'host-state'));const otherHost=await McpAuthorization.open(join(workspace,'other-host'));let service=await ProjectMcpConnections.open(workspace,authority)
  try{
    const draft=await service.save({operationId:'initial',title:'Host-bound',config,note:'Configuration'})
    const approval={id:draft.id,revision:1,operationId:'enable',enabled:true,note:'Human enablement'}
    const enabled=await service.setEnabled(approval);expect(service.authorized(enabled)).toBe(true)
    await service.dispose();const backup=await readFile(join(workspace,'.omicos-oss','mcp.sqlite'));service=await ProjectMcpConnections.open(workspace,authority)
    await service.setEnabled({id:draft.id,revision:2,operationId:'disable',enabled:false,note:'Revoked here'})
    await service.dispose();await writeFile(join(workspace,'.omicos-oss','mcp.sqlite'),backup);service=await ProjectMcpConnections.open(workspace,authority)
    expect(service.get(draft.id).enabled).toBe(true);expect(service.authorized(service.get(draft.id))).toBe(false)
    expect(service.authorized(await service.setEnabled(approval))).toBe(false)
    await expect(service.reconnect({id:draft.id,revision:2,operationId:'reconnect-untrusted',note:'Cannot reconnect old grant'})).rejects.toMatchObject({status:409})
    const fail=vi.spyOn(authority,'grant').mockImplementationOnce(()=>{throw new Error('Simulated grant persistence failure')})
    const request={id:draft.id,revision:2,operationId:'reauthorize-failed',enabled:true,note:'Fresh decision with grant failure'}
    await expect(service.setEnabled(request)).rejects.toThrow('grant persistence failure');fail.mockRestore()
    expect(service.get(draft.id).revision).toBe(3);expect(service.authorized(await service.setEnabled(request))).toBe(false)
    const renewed=await service.setEnabled({...request,revision:3,operationId:'reauthorize-success'});expect(service.authorized(renewed)).toBe(true)
    await service.dispose();service=await ProjectMcpConnections.open(workspace,otherHost)
    expect(service.authorized(service.get(draft.id))).toBe(false)
    await service.dispose();const copied=join(workspace,'copied-project');await mkdir(join(copied,'.omicos-oss'),{recursive:true});await writeFile(join(copied,'.omicos-oss','mcp.sqlite'),await readFile(join(workspace,'.omicos-oss','mcp.sqlite')))
    const clone=await ProjectMcpConnections.open(copied,authority);try{expect(clone.get(draft.id).enabled).toBe(true);expect(clone.authorized(clone.get(draft.id))).toBe(false)}finally{await clone.dispose()}
  }finally{await service.dispose();authority.dispose();otherHost.dispose();await rm(workspace,{recursive:true,force:true})}
})
