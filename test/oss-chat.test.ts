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
})
