import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { ChatSnapshot } from '../oss/chat.js'

export function ScienceChat({ projectId }: { projectId: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<Partial<ChatSnapshot> & { available?: boolean; reason?: string }>()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ text: string; requestId: string }>()
  const prefix = `project/${projectId}/`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api<Partial<ChatSnapshot> & { available?: boolean; reason?: string }>(`${prefix}chat`, undefined, signal)
    if (!signal?.aborted) { setSnapshot(result); setError('') }
  }, [prefix])
  useEffect(() => {
    const controller = new AbortController()
    const load = () => { void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }) }
    load(); const timer = setInterval(() => { if (!document.hidden) load() }, 3500)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])
  const send = async () => {
    if (busy || !draft.trim()) return
    const request = pending.current?.text === draft ? pending.current : { text: draft, requestId: crypto.randomUUID() }
    pending.current = request; setBusy(true); setError('')
    try {
      await api(`${prefix}chat-send`, request)
      pending.current = undefined; setDraft(''); await refresh()
    } catch (error) { setError(`发送尚未确认：${error instanceof Error ? error.message : String(error)}。保留原文重试会使用相同请求编号，避免重复消息。`) }
    finally { setBusy(false) }
  }
  return <article className="oss-card oss-chat"><div className="oss-row"><h2>OmicOS Scientist</h2><span className="oss-chip">{snapshot?.busy ? '正在研究' : '项目固定会话'}</span></div>
    <p>与 Harness 中同一个科研 Agent 对话，保留会话历史并使用当前项目的记忆与数据对象。</p>
    {snapshot?.available === false && <p className="oss-note">{snapshot.reason}</p>}
    {error && <p role="status" className="oss-error">{error}</p>}
    {snapshot?.sessionId && <details><summary>会话与权限</summary><code>{snapshot.sessionId}</code><p>需要批准科研工具时，请在 Harness 主窗口完成审批。此窗口不跳过权限检查。</p></details>}
    <div className="oss-chat-history" role="log" aria-live="polite">{snapshot?.messages?.map(item => <div className={`oss-chat-message oss-chat-${item.role}`} key={item.seq}><small>{item.role === 'user' ? '你' : 'OmicOS Scientist'}{item.interrupted ? ' · 已中断' : ''}</small><p>{item.text}</p></div>)}{snapshot?.available !== false && snapshot?.messages?.length === 0 && <p>从一个科研问题开始。发送后将创建并绑定此项目的专属会话。</p>}{snapshot?.hasMore && <p>这里只显示最近的对话；完整历史由 Harness 保存。</p>}</div>
    {snapshot?.available !== false && <form onSubmit={event => { event.preventDefault(); void send() }}><label htmlFor={`oss-chat-${projectId}`}>科研问题<textarea id={`oss-chat-${projectId}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={20000} placeholder="例如：先检查当前 adata 的状态，再规划下一步分析。" /></label><div className="oss-row"><button type="button" disabled={!snapshot?.sessionId} onClick={() => void api(`${prefix}chat-cancel`, {}).then(() => refresh()).catch(error => setError(String(error)))}>请求停止当前回复</button><button className="oss-primary" type="submit" disabled={busy || !draft.trim()}>{busy ? '正在发送…' : '发送给科研 Agent'}</button></div></form>}
  </article>
}
