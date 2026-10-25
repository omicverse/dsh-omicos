import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { ChatSnapshot } from '../oss/chat.js'

type ChatView=Partial<ChatSnapshot>&{available?:boolean;reason?:string;streaming?:boolean}
export function ScienceChat({ projectId }: { projectId: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<ChatView>()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<{projectId:string;text:string;requestId:string}>();const identity=useRef(projectId);identity.current=projectId
  const generation=useRef(0);const live=useRef(false);const [connection,setConnection]=useState('connecting')
  const prefix = `project/${projectId}/`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const expected=generation.current;const result = await api<ChatView>(`${prefix}chat`, undefined, signal)
    if (!signal?.aborted&&identity.current===projectId&&generation.current===expected) { setSnapshot(previous=>live.current&&previous?.sessionId===result.sessionId&&(previous?.cursor??-1)>=(result.cursor??0)?{...previous,streaming:result.streaming}:result); setError('') }
  }, [prefix,projectId])
  useEffect(() => {
    generation.current++;const controller = new AbortController()
    const load = () => { void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }) }
    setSnapshot(undefined);setDraft('');setBusy(false);setError('');pending.current=undefined;setConnection('connecting');load();let ticks=0;const timer = setInterval(() => { if (!document.hidden&&(!live.current||++ticks%10===0)) load() }, 3500)
    return () => { generation.current++;controller.abort(); clearInterval(timer) }
  }, [refresh])
  useEffect(()=>{
    if(!snapshot?.sessionId||!snapshot.streaming){setConnection(snapshot?.available===false?'unavailable':'polling');return}
    let closed=false;const sessionId=snapshot.sessionId,source=new EventSource(`/omicos/oss/api/${prefix}chat-events`)
    source.onopen=()=>{if(closed)return;live.current=true;setConnection('live')};source.onerror=()=>{if(closed)return;live.current=false;setSnapshot(value=>value?{...value,live:undefined}:value);setConnection('reconnecting')}
    source.addEventListener('chat',event=>{if(closed)return;try{const value=JSON.parse((event as MessageEvent).data) as ChatSnapshot;if(value.sessionId!==sessionId||identity.current!==projectId)return;setSnapshot({...value,streaming:true});setError('')}catch{live.current=false;source.close();setConnection('polling')}})
    return()=>{closed=true;live.current=false;source.close()}
  },[prefix,projectId,snapshot?.sessionId,snapshot?.streaming,snapshot?.available])
  const send = async () => {
    if (busy || !draft.trim()) return
    const request = pending.current?.projectId===projectId&&pending.current?.text === draft ? pending.current : { projectId,text: draft, requestId: crypto.randomUUID() }
    const expected=generation.current;pending.current = request; setBusy(true); setError('')
    try {
      await api(`${prefix}chat-send`, {text:request.text,requestId:request.requestId});if(identity.current!==projectId||generation.current!==expected)return
      pending.current = undefined; setDraft(''); await refresh()
    } catch (error) { if(identity.current===projectId&&generation.current===expected)setError(`发送尚未确认：${error instanceof Error ? error.message : String(error)}。保留原文重试会使用相同请求编号，避免重复消息。`) }
    finally { if(identity.current===projectId&&generation.current===expected)setBusy(false) }
  }
  return <article className="oss-card oss-chat"><div className="oss-row"><h2>OmicOS Scientist</h2><span className="oss-chip">{snapshot?.busy ? '正在研究' : '项目固定会话'}</span></div>
    <p><small data-chat-connection>{connection==='live'?'实时连接':connection==='reconnecting'?'正在重连，显示已确认记录':connection==='polling'?'定时同步':connection==='unavailable'?'未连接科研 Agent':'正在连接'}</small></p><p>与 Harness 中同一个科研 Agent 对话，保留会话历史并使用当前项目的记忆与数据对象。</p>
    {snapshot?.available === false && <p className="oss-note">{snapshot.reason}</p>}
    {error && <p role="status" className="oss-error">{error}</p>}
    {snapshot?.sessionId && <details><summary>会话与权限</summary><code>{snapshot.sessionId}</code><p>需要批准科研工具时，请在 Harness 主窗口完成审批。此窗口不跳过权限检查。</p></details>}
    <div className="oss-chat-history" role="log" aria-live="polite">{snapshot?.messages?.map(item => <div className={`oss-chat-message oss-chat-${item.role}`} key={item.seq}><small>{item.role === 'user' ? '你' : 'OmicOS Scientist'}{item.interrupted ? ' · 已中断' : ''}{item.truncated?' · 窗口内容已截短':''}</small><p>{item.text}</p></div>)}{snapshot?.live&&<div className="oss-chat-message oss-chat-assistant" data-chat-live><small>OmicOS Scientist · 正在回复{snapshot.live.truncated?' · 实时窗口已截短':''}</small><p aria-live="off">{snapshot.live.text}</p></div>}{snapshot?.available !== false && snapshot?.messages?.length === 0 && <p>从一个科研问题开始。发送后将创建并绑定此项目的专属会话。</p>}{snapshot?.sessionId&&<p>这里只显示近期会话文本；完整历史由 Harness 保存。</p>}</div>
    {snapshot?.available !== false && <form onSubmit={event => { event.preventDefault(); void send() }}><label htmlFor={`oss-chat-${projectId}`}>科研问题<textarea id={`oss-chat-${projectId}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={20000} placeholder="例如：先检查当前 adata 的状态，再规划下一步分析。" /></label><div className="oss-row"><button type="button" disabled={!snapshot?.sessionId} onClick={() => void api(`${prefix}chat-cancel`, {}).then(() => refresh()).catch(error => setError(String(error)))}>请求停止当前回复</button><button className="oss-primary" type="submit" disabled={busy || !draft.trim()}>{busy ? '正在发送…' : '发送给科研 Agent'}</button></div></form>}
  </article>
}
