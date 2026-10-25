import {useEffect,useRef,useState} from 'react'
import type {ChatHistory as HistoryPage} from '../oss/chat.js'
import {api} from './oss-api.js'

/** Separate, bounded historical view: live updates never rewrite the chosen page. */
export function ChatHistory({projectId,sessionId}:{projectId:string;sessionId:string}):JSX.Element{
 const [page,setPage]=useState<HistoryPage>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[open,setOpen]=useState(false)
 const request=useRef<AbortController>(),generation=useRef(0)
 useEffect(()=>()=>{generation.current++;request.current?.abort()},[projectId,sessionId])
 const load=async(older:boolean)=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;const expected=++generation.current;setBusy(true);setError('')
  const params=new URLSearchParams();if(older&&page){params.set('through',String(page.throughSeq));if(page.nextBefore!==undefined)params.set('before',String(page.nextBefore))}
  try{const value=await api<HistoryPage>(`project/${projectId}/chat-history?${params}`,undefined,controller.signal);if(controller.signal.aborted||generation.current!==expected)return;if(value.sessionId!==sessionId)throw Error('固定会话已改变，请重新打开历史');setPage(value)}catch(error){if(!controller.signal.aborted&&generation.current===expected)setError(String(error))}finally{if(!controller.signal.aborted&&generation.current===expected)setBusy(false)}
 }
 return <section className="oss-card"><button type="button" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open&&!page)void load(false)}}>浏览固定会话历史</button>{open&&<><p>每页最多 50 条公开消息；查看历史不会发起模型请求。实时回复继续保留在上方。此处为历史事件文本，跨页修订可能保留旧版本。</p><div className="oss-row"><button type="button" disabled={busy} onClick={()=>void load(false)}>重新读取最新历史</button><button type="button" disabled={busy||!page?.hasMore||page.nextBefore===undefined} onClick={()=>void load(true)}>更早一页</button></div>{busy&&<p role="status">正在读取历史…</p>}{error&&<p role="status" className="oss-error">{error}</p>}{page&&<><p>历史边界 #{page.throughSeq}{page.beforeSeq!==undefined?` · 记录 #${page.beforeSeq} 之前`:''} · {page.hasMore?'还有更早记录':'已到历史起点'}</p>{page.messages.map(item=><div className={`oss-chat-message oss-chat-${item.role}`} key={item.seq}><small>{item.role==='user'?'你':'OmicOS Scientist'} · #{item.seq}{item.interrupted?' · 已中断':''}{item.truncated?' · 内容已截短':''}</small><p>{item.text}</p></div>)}{!page.messages.length&&<p>本页没有公开文本，可能只有工具或内部事件；可继续查看更早一页。</p>}</>}</>}</section>
}
