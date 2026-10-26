import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { SessionController, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatHistory, ChatSnapshot, ScienceChat } from '../oss/chat.js'
import { readJson, writeJson } from '../oss/storage.js'

export {publicChatRecords as projectChatRecords} from '../oss/chat-projection.js'
import {publicChatRecords,ChatProjection} from '../oss/chat-projection.js'

export class HarnessScienceChat implements ScienceChat {
  private stopping=new AbortController();private followers=new Set<AsyncGenerator<ChatSnapshot|{messages:[];available:true}>>();private disposing?:Promise<void>
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
      if(first.value.header.id!==sessionId)throw new Error('Harness returned a different conversation identity')
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
  follow(workspace:string,signal:AbortSignal):AsyncIterable<ChatSnapshot|{messages:[];available:true}>{
    this.stopping.signal.throwIfAborted();signal.throwIfAborted();if(this.followers.size>=32)throw Error('Too many live conversation observers')
    const own=new AbortController();const iterator=this.observe(workspace,AbortSignal.any([signal,own.signal,this.stopping.signal]),()=>this.followers.delete(iterator));const close=iterator.return.bind(iterator);iterator.return=async value=>{own.abort();try{return await close(value)}finally{this.followers.delete(iterator)}};this.followers.add(iterator);return iterator
  }
  private async *observe(workspace:string,signal:AbortSignal,closed:()=>void):AsyncGenerator<ChatSnapshot|{messages:[];available:true}>{
    try{const sessionId=await this.bound(workspace);signal.throwIfAborted();if(!sessionId){yield {messages:[],available:true};return}const projection=new ChatProjection(sessionId);let opened=false
      for await(const frame of this.controller.follow({address:{kind:'session',sessionId:SessionId(sessionId)},maxMessages:50,assistantStream:true},signal)){
        signal.throwIfAborted();if(!opened&&frame.type!=='snapshot')throw Error('Harness did not provide a conversation opening snapshot');if(frame.type==='snapshot'){if(!frame.header.cwd||resolve(frame.header.cwd)!==resolve(workspace))throw Error('Conversation is bound to a different workspace; refusing to expose it');if(frame.header.id!==sessionId)throw Error('Harness returned a different conversation identity');opened=true}yield projection.accept(frame)
      }
    }finally{closed()}
  }
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.stopping.abort();return this.disposing=Promise.allSettled([...this.followers].map(iterator=>iterator.return(undefined))).then(()=>{this.followers.clear()})}
  async read(workspace: string, signal: AbortSignal): Promise<ChatSnapshot | { messages: []; available: true }> {
    signal=AbortSignal.any([signal,this.stopping.signal]);signal.throwIfAborted()
    const sessionId = await this.bound(workspace)
    if (!sessionId) return { messages: [], available: true }
    const snapshot = await this.opening(sessionId, workspace, signal)
    return new ChatProjection(sessionId).accept(snapshot)
  }
  async history(workspace:string,options:{throughSeq?:number;beforeSeq?:number},signal:AbortSignal):Promise<ChatHistory>{
    signal=AbortSignal.any([signal,this.stopping.signal]);signal.throwIfAborted()
    for(const value of [options.throughSeq,options.beforeSeq])if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw Error('Invalid conversation history cursor')
    const sessionId=await this.bound(workspace);if(!sessionId)throw Error('No fixed conversation has been created')
    const opening=await this.opening(sessionId,workspace,signal),throughSeq=options.throughSeq??opening.cursor
    if(throughSeq>opening.cursor||options.beforeSeq!==undefined&&options.beforeSeq>throughSeq+1)throw Error('Conversation history cursor exceeds its durable boundary')
    const page=await this.controller.page({address:{kind:'session',sessionId:SessionId(sessionId)},throughSeq,beforeSeq:options.beforeSeq,maxMessages:50},signal)
    signal.throwIfAborted()
    const first=page.records[0]?.event.seq
    if(page.hasMore&&(first===undefined||first>=(options.beforeSeq??throughSeq+1)))throw Error('Harness history page did not advance')
    return {sessionId,throughSeq,beforeSeq:options.beforeSeq,messages:publicChatRecords(page.records),hasMore:page.hasMore,...page.hasMore?{nextBefore:first}:{}}
  }
  async send(workspace: string, text: string, requestId: string, signal: AbortSignal): Promise<{ sessionId: string; accepted: true }> {
    signal=AbortSignal.any([signal,this.stopping.signal]);signal.throwIfAborted()
    if (!text.trim() || text.length > 20000 || !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw new Error('A bounded message and stable request ID are required')
    const sessionId = await this.ensure(workspace, signal)
    signal.throwIfAborted()
    // The formal controller persists rpcId and deduplicates retried human prompts.
    await this.controller.prompt({ sessionId: SessionId(sessionId), requestId: requestId as Parameters<SessionController['prompt']>[0]['requestId'], mode: 'queue', content: [{ type: 'text', text }] }, signal)
    return { sessionId, accepted: true }
  }
  async cancel(workspace: string): Promise<void> {
    this.stopping.signal.throwIfAborted()
    const sessionId = await this.bound(workspace)
    if (!sessionId) return
    await this.opening(sessionId, workspace, this.stopping.signal)
    this.controller.cancel({ sessionId: SessionId(sessionId) })
  }
}
