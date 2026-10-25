import { useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { EnvironmentSelection, ManagedPythonEnvironment, LockedPackage } from '../oss/environment-types.js'
type Listing = { entries: Array<Omit<ManagedPythonEnvironment,'logTail'|'packages'> & {packages:number}>; next?:number; selection:EnvironmentSelection; basePython:string; currentInterpreter:string; currentUnavailable?:string; installSupported:boolean }
const message=(error:unknown)=>error instanceof Error?error.message:String(error)
export function ManagedEnvironmentPane({projectId,visible}:{projectId:string;visible:boolean}):JSX.Element{
  const prefix=`project/${projectId}/managed-environment-`
  const [expanded,setExpanded]=useState(false);const [listing,setListing]=useState<Listing>();const [before,setBefore]=useState<number>();const [id,setId]=useState('');const [document,setDocument]=useState<ManagedPythonEnvironment>()
  const [title,setTitle]=useState('新的科研环境');const [packages,setPackages]=useState('[]');const [wheels,setWheels]=useState('');const [choice,setChoice]=useState('');const [history,setHistory]=useState<EnvironmentSelection[]>([])
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const operation=useRef<{key:string;id:string}>()
  const operationId=(request:unknown)=>{const key=JSON.stringify(request);if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};return operation.current.id}
  const readList=async()=>{const result=await api<Listing>(`${prefix}list${before?`?before=${before}`:''}`);setListing(result);return result}
  useEffect(()=>{
    if(!visible || !expanded)return
    const controller=new AbortController()
    const read=async()=>{try{const result=await api<Listing>(`${prefix}list${before?`?before=${before}`:''}`,undefined,controller.signal);if(!controller.signal.aborted)setListing(result);if(id){const record=await api<ManagedPythonEnvironment>(`${prefix}document?id=${encodeURIComponent(id)}`,undefined,controller.signal);if(!controller.signal.aborted)setDocument(record)}}catch(error){if(!controller.signal.aborted)setError(message(error))}}
    void read();const timer=window.setInterval(()=>void read(),2000);return()=>{controller.abort();window.clearInterval(timer)}
  },[prefix,before,id,visible,expanded])
  const action=async(task:()=>Promise<void>)=>{setBusy(true);setError('');try{await task()}catch(error){setError(message(error))}finally{setBusy(false)}}
  const install=()=>void action(async()=>{const request={title,packages:JSON.parse(packages) as LockedPackage[],...(wheels.trim()?{wheelDirectory:wheels.trim()}:{})};const record=await api<ManagedPythonEnvironment>(`${prefix}install`,{confirmed:true,install:{...request,operationId:operationId({install:request})}});setId(record.id);setDocument(record);await readList()})
  const select=()=>void action(async()=>{if(!listing)throw new Error('请先读取环境状态');const request={revision:listing.selection.revision,environmentId:choice||null};await api(`${prefix}select`,{confirmed:true,selection:{...request,operationId:operationId({select:request})}});await readList()})
  return <section aria-label="托管 Python 环境"><details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>按需安装与回退 Python 环境</summary>
    <p>使用已配置的 Python 创建独立 venv。不会修改系统或当前环境；安装第三方包可能下载文件并运行包代码，请只安装你信任的包。当前仅支持 POSIX，Python 基础解释器需自行提供。</p>
    {error&&<p className="oss-error" role="alert">{error}</p>}
    {listing&&<><p>当前 Host：<code>{listing.currentInterpreter}</code><br />下次启动：<code>{listing.selection.environmentId||`外部 Python (${listing.basePython})`}</code> · 选择修订 {listing.selection.revision}</p>{listing.currentUnavailable&&<p className="oss-error" role="alert">{listing.currentUnavailable}</p>}</>}
    <label>新环境名称<input aria-label="新托管环境名称" maxLength={200} value={title} onChange={event=>setTitle(event.target.value)} /></label>
    <label>精确版本与 SHA-256 锁定包（JSON）<textarea aria-label="托管环境锁定包 JSON" className="oss-code" value={packages} onChange={event=>setPackages(event.target.value)} spellCheck={false} /></label>
    <p>空数组仅创建基础环境，不联网安装科研包。包格式：<code>{'[{"name":"包名","version":"精确版本","sha256":["wheel 的 64 位 SHA-256"]}]'}</code>。所有依赖都须固定版本与哈希，只安装 wheel，不接受源码包、安装选项或自定义索引。</p>
    <label>离线 wheel 目录（项目内相对路径，可留空使用 PyPI）<input aria-label="托管环境离线 wheel 目录" maxLength={2000} value={wheels} onChange={event=>setWheels(event.target.value)} /></label>
    <button className="oss-primary" disabled={busy||!listing?.installSupported||!title.trim()} onClick={install}>批准创建并安装独立环境</button>
    <div className="oss-toolbar"><button disabled={busy||!before} onClick={()=>setBefore(undefined)}>环境第一页</button><button disabled={busy||!listing?.next} onClick={()=>setBefore(listing?.next)}>更早的托管环境</button></div>
    <label>安装记录<select aria-label="托管环境安装记录" value={id} disabled={busy} onChange={event=>{setId(event.target.value);setDocument(undefined)}}><option value="">选择记录</option>{id&&!listing?.entries.some(item=>item.id===id)&&<option value={id}>当前安装 · {id}</option>}{listing?.entries.map(item=><option key={item.id} value={item.id}>{item.title} · {item.state} · {item.packages} 个锁定包</option>)}</select></label>
    {document&&<section aria-label="托管环境安装详情"><strong>安装状态：<span data-environment-state>{document.state}</span></strong><p><code>{document.id}</code><br /><code>{document.interpreter}</code></p>{document.error&&<p role="alert" className="oss-error">{document.error}</p>}{document.manifestSha256&&<p>环境文件 SHA-256：<code>{document.manifestSha256}</code></p>}<details><summary>安装日志（最近 64000 字符）</summary><pre>{document.logTail||'暂无输出'}</pre></details><details><summary>锁定清单与实际包版本</summary><pre>{JSON.stringify({requested:document.packages,installed:document.installed,python:document.pythonVersion},null,2)}</pre></details><button disabled={busy||!['preparing','installing','verifying'].includes(document.state)} onClick={()=>void action(async()=>{setDocument(await api(`${prefix}cancel`,{id:document.id,confirmed:true}));await readList()})}>取消此次安装</button><button disabled={busy||!['failed','canceled','interrupted'].includes(document.state)} onClick={()=>void action(async()=>{if(!window.confirm('删除此次失败/中断安装的环境文件？安装记录和日志会保留。'))return;setDocument(await api(`${prefix}remove`,{id:document.id,confirmed:true}));await readList()})}>删除此次未完成环境的文件</button></section>}
    <h3>选择下次 Host 启动的环境</h3><p>保存选择不会切换当前内核、清空对象或重跑分析。重启 Host 后，新的项目 Python 和 Python Pipeline 使用所选环境；已存在的 Pipeline 恢复仍会核对原环境。回退可选择先前 ready 的环境或外部 Python。</p>
    <label>下次启动环境<select aria-label="下次 Host 启动环境" value={choice} disabled={busy} onChange={event=>setChoice(event.target.value)}><option value="">外部 Python（回退）</option>{choice&&!listing?.entries.some(item=>item.id===choice)&&<option value={choice}>指定环境 · {choice}</option>}{listing?.entries.filter(item=>item.state==='ready').map(item=><option key={item.id} value={item.id}>{item.title} · {item.id.slice(0,8)}</option>)}</select></label><label>或填写历史 ready 环境完整编号<input aria-label="历史托管环境编号" maxLength={150} value={choice} onChange={event=>setChoice(event.target.value)} /></label>
    <button disabled={busy||!listing} onClick={select}>批准保存下次启动环境</button><button disabled={busy} onClick={()=>void action(async()=>{setHistory((await api<{entries:EnvironmentSelection[]}>(`${prefix}history`)).entries)})}>读取环境选择历史</button>
    {history.length>0&&<details open><summary>最近环境选择修订</summary><pre>{JSON.stringify(history,null,2)}</pre></details>}
  </details></section>
}
