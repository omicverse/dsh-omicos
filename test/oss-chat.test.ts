import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { HarnessScienceChat, projectChatRecords } from '../src/host/oss-chat.js'

describe('Harness fixed scientific conversation bridge', () => {
  let workspace: string
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'omicos-chat-')); await mkdir(join(workspace, '.omicos-oss')) })
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }) })
  function fake() {
    let created = 0; let stopped = 0; let released = 0; const accepted = new Set<string>(); const sent: unknown[] = []
    const controller = {
      async projections() { return null },
      async create(request: any) { created++; return { sessionId: request.sessionId, agentPreset: request.agentPreset } },
      async *follow(request: any) { try { yield { type: 'snapshot', header: { id: request.address.sessionId, cwd: workspace }, records: [], cursor: 0, hasMore: false } } finally { released++ } },
      async prompt(request: any) { if (!accepted.has(request.requestId)) { accepted.add(request.requestId); sent.push(request) } return { accepted: true } },
      cancel() { stopped++; return { canceled: true } },
    }
    return { controller: controller as unknown as SessionController, count: () => ({ created, stopped, released, sent }) }
  }
  it('cold reads do not create agents or spend model tokens', async () => {
    const host = fake(); const chat = new HarnessScienceChat(host.controller)
    expect(await chat.read(workspace, new AbortController().signal)).toEqual({ messages: [], available: true })
    expect(host.count().created).toBe(0)
  })
  it('creates one project-specific scientist session, binds durably and preserves request IDs on retries', async () => {
    const host = fake(); const chat = new HarnessScienceChat(host.controller); const signal = new AbortController().signal
    const first = await chat.send(workspace, 'Inspect my dataset', 'request-1', signal)
    await chat.send(workspace, 'Inspect my dataset', 'request-1', signal)
    const reopened = new HarnessScienceChat(host.controller)
    const second = await reopened.send(workspace, 'Continue', 'request-2', signal)
    expect(first.sessionId).toBe(second.sessionId)
    expect(host.count().created).toBe(1)
    expect(host.count().sent).toHaveLength(2)
    expect(JSON.parse(await readFile(join(workspace, '.omicos-oss', 'chat.json'), 'utf8')).agentPreset).toBe('omicos')
    await chat.cancel(workspace)
    expect(host.count().stopped).toBe(1)
    expect(host.count().released).toBeGreaterThan(0)
  })
  it('rejects a corrupted binding to a different workspace before sending messages', async () => {
    const host = fake(); const chat = new HarnessScienceChat(host.controller)
    host.controller.follow = async function* () { yield { type: 'snapshot', header: { cwd: '/another-project' }, records: [], cursor: 0 } as any }
    await writeFile(join(workspace, '.omicos-oss', 'chat.json'), JSON.stringify({ sessionId: 'wrong-project' }))
    await expect(chat.send(workspace, 'Hello', 'request', new AbortController().signal)).rejects.toThrow('different workspace')
    expect(host.count().sent).toHaveLength(0)
  })
  it('projects current messages, removes replacements and omits synthetic context and reasoning', () => {
    const event = (seq: number, type: string, data: unknown, surfaceOp?: unknown) => ({ type: 'event', event: { seq, type, data, surfaceOp } })
    const records = [
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }),
      event(2, 'user/message', { source: { kind: 'context' }, content: [{ type: 'text', text: 'Private injected context' }] }),
      event(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'Private thought' }, { type: 'text', text: 'Old answer' }] } }),
      event(4, 'assistant/message', { message: { content: [{ type: 'text', text: 'Correct answer' }] } }, { op: 'replace', startSeq: 3, endSeq: 3 }),
    ]
    expect(projectChatRecords(records).map(item => item.text)).toEqual(['Question', 'Correct answer'])
  })
  it('follows only the exact bound session, releases paused observers and never cancels a model when a window closes',async()=>{
    const host=fake(),chat=new HarnessScienceChat(host.controller),signal=new AbortController().signal
    const cold=chat.follow(workspace,signal)[Symbol.asyncIterator]();expect((await cold.next()).value).toEqual({messages:[],available:true});await cold.return?.();expect(host.count().created).toBe(0)
    await chat.send(workspace,'Question','follow-request',signal);const sessionId=JSON.parse(await readFile(join(workspace,'.omicos-oss','chat.json'),'utf8')).sessionId;const iterator=chat.follow(workspace,signal)[Symbol.asyncIterator]();expect((await iterator.next()).value.sessionId).toBe(sessionId);await iterator.return?.();expect(host.count().stopped).toBe(0)
    for(let i=0;i<40;i++){const unused=chat.follow(workspace,signal)[Symbol.asyncIterator]();await unused.return?.()}
    const paused=chat.follow(workspace,signal)[Symbol.asyncIterator]();await paused.next();await chat.dispose();expect(host.count().stopped).toBe(0);expect(()=>chat.follow(workspace,signal)).toThrow();await expect(chat.read(workspace,signal)).rejects.toMatchObject({name:'AbortError'})
  })
  it('rejects a same-workspace but different-session opening before exposing messages',async()=>{
    const host=fake(),chat=new HarnessScienceChat(host.controller);await writeFile(join(workspace,'.omicos-oss','chat.json'),JSON.stringify({sessionId:'bound'}));host.controller.follow=async function*(){yield {type:'snapshot',header:{id:'another',cwd:workspace},records:[{type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'PRIVATE_OTHER_SESSION'}]}}}}],cursor:1,hasMore:false} as any};const iterator=chat.follow(workspace,new AbortController().signal)[Symbol.asyncIterator]();await expect(iterator.next()).rejects.toThrow(/different conversation/);host.controller.follow=async function*(){yield {type:'snapshot',header:{id:'bound',cwd:workspace},records:[],cursor:0,hasMore:false} as any;yield {type:'snapshot',header:{id:'another',cwd:workspace},records:[],cursor:0,hasMore:false} as any};const reset=chat.follow(workspace,new AbortController().signal)[Symbol.asyncIterator]();await reset.next();await expect(reset.next()).rejects.toThrow(/different conversation/);await chat.dispose()
  })

})
