import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { SessionController, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatMessage, ChatSnapshot, ScienceChat } from '../oss/chat.js'
import { readJson, writeJson } from '../oss/storage.js'

/** Only the known message surface is projected; arbitrary event payloads are not instructions. */
export function projectChatRecords(records: readonly unknown[]): ChatMessage[] {
  let messages: ChatMessage[] = []
  for (const record of records) {
    const item = record as { type?: string; event?: { type: string; seq: number; surfaceOp?: string | { op: string; startSeq: number; endSeq: number }; data: any } }
    if (item.type !== 'event' || !item.event) continue
    const event = item.event
    const operation = event.surfaceOp
    if (typeof operation === 'object' && operation.op === 'replace') messages = messages.filter(message => message.seq < operation.startSeq || message.seq > operation.endSeq)
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
    if (!role) continue
    const data = role === 'user' ? event.data : event.data?.message
    // Hide synthetic system-context user messages; only real human prompts belong in this chat UI.
    if (role === 'user' && data?.source?.kind !== 'user') continue
    const content = data?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
    if (text) messages.push({ seq: event.seq, role, text: text.slice(-100000), ...(event.data?.interrupted ? { interrupted: true } : {}) })
  }
  return messages
}

export class HarnessScienceChat implements ScienceChat {
  private creating = new Map<string, Promise<string>>()
  constructor(private controller: SessionController) {}
  private file(workspace: string): string { return join(workspace, '.omicos-oss', 'chat.json') }
  private async bound(workspace: string): Promise<string | undefined> {
    const state = await readJson<{ sessionId: string } | null>(this.file(workspace), null)
    return state?.sessionId
  }
  private async opening(sessionId: string, workspace: string | undefined, signal: AbortSignal): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
    const own = new AbortController()
    const combined = AbortSignal.any([signal, own.signal, AbortSignal.timeout(20000)])
    const iterator = this.controller.follow({ address: { kind: 'session', sessionId: SessionId(sessionId) }, maxMessages: 50 }, combined)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done || first.value.type !== 'snapshot') throw new Error('Harness did not provide a conversation opening snapshot')
      if (!first.value.header.cwd || (workspace !== undefined && resolve(first.value.header.cwd) !== resolve(workspace))) throw new Error('Conversation is bound to a different workspace; refusing to expose it')
      return first.value
    } finally { own.abort(); await iterator.return?.() }
  }
  async workspaceForSession(sessionId: string, signal: AbortSignal): Promise<string> {
    return (await this.opening(sessionId, undefined, signal)).header.cwd!
  }
  private async ensure(workspace: string, signal: AbortSignal): Promise<string> {
    let pending = this.creating.get(workspace)
    if (!pending) {
      pending = (async () => {
        const existing = await this.bound(workspace)
        if (existing) { await this.opening(existing, workspace, signal); return existing }
        const requested = `omicos-oss-${createHash('sha256').update(workspace).digest('hex').slice(0, 24)}`
        const saved = await this.controller.projections({ sessionId: SessionId(requested) }, signal)
        let sessionId = requested
        if (saved === null) sessionId = (await this.controller.create({ sessionId: SessionId(requested), cwd: workspace, agentPreset: 'omicos' })).sessionId
        await this.opening(sessionId, workspace, signal)
        await writeJson(this.file(workspace), { protocol: 1, sessionId, agentPreset: 'omicos' })
        return sessionId
      })()
      this.creating.set(workspace, pending)
      pending.finally(() => { if (this.creating.get(workspace) === pending) this.creating.delete(workspace) }).catch(() => {})
    }
    return pending
  }
  async read(workspace: string, signal: AbortSignal): Promise<ChatSnapshot | { messages: []; available: true }> {
    const sessionId = await this.bound(workspace)
    if (!sessionId) return { messages: [], available: true }
    const snapshot = await this.opening(sessionId, workspace, signal)
    const records = snapshot.records as readonly any[]
    let busy = false
    for (const record of records) { if (record.event?.type === 'turn/start') busy = true; if (record.event?.type === 'turn/end') busy = false }
    return { sessionId, messages: projectChatRecords(records), hasMore: snapshot.hasMore, cursor: snapshot.cursor, busy }
  }
  async send(workspace: string, text: string, requestId: string, signal: AbortSignal): Promise<{ sessionId: string; accepted: true }> {
    if (!text.trim() || text.length > 20000 || !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw new Error('A bounded message and stable request ID are required')
    const sessionId = await this.ensure(workspace, signal)
    signal.throwIfAborted()
    // The formal controller persists rpcId and deduplicates retried human prompts.
    await this.controller.prompt({ sessionId: SessionId(sessionId), requestId: requestId as Parameters<SessionController['prompt']>[0]['requestId'], mode: 'queue', content: [{ type: 'text', text }] }, signal)
    return { sessionId, accepted: true }
  }
  async cancel(workspace: string): Promise<void> {
    const sessionId = await this.bound(workspace)
    if (!sessionId) return
    await this.opening(sessionId, workspace, new AbortController().signal)
    this.controller.cancel({ sessionId: SessionId(sessionId) })
  }
}
