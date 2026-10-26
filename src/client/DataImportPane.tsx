import { useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import { sourceManifest, transferUpload } from './file-upload.js'
import { portableUploadName, type DataUpload, type UploadSummary } from '../oss/upload-types.js'
type Page={entries:UploadSummary[];next?:number}
const message=(error:unknown)=>error instanceof Error?error.message:String(error)
export function DataImportPane({projectId,directory,visible,committed}:{projectId:string;directory:string;visible:boolean;committed:()=>Promise<void>}):JSX.Element{
  const prefix=`project/${projectId}/upload-`;const [expanded,setExpanded]=useState(false);const [file,setFile]=useState<File>();const [name,setName]=useState('');const [expected,setExpected]=useState('')
  const [page,setPage]=useState<Page>({entries:[]});const [before,setBefore]=useState<number>();const [record,setRecord]=useState<DataUpload>();const [id,setId]=useState('');const [lookup,setLookup]=useState('')
  const [busy,setBusy]=useState(false);const [phase,setPhase]=useState('');const [hashed,setHashed]=useState(0);const [error,setError]=useState('');const controller=useRef<AbortController>();const operation=useRef<{key:string;id:string}>()
  useEffect(()=>()=>controller.current?.abort(),[])
  useEffect(()=>{if(!visible)controller.current?.abort()},[visible])
  const list=async()=>setPage(await api<Page>(`${prefix}list${before?`?before=${before}`:''}`))
  useEffect(()=>{if(!visible||!expanded||busy)return;const abort=new AbortController();const read=async()=>{try{const result=await api<Page>(`${prefix}list${before?`?before=${before}`:''}`,undefined,abort.signal);if(!abort.signal.aborted)setPage(result);if(id){const latest=await api<DataUpload>(`${prefix}document?id=${encodeURIComponent(id)}`,undefined,abort.signal);if(!abort.signal.aborted)setRecord(latest)}}catch(error){if(!abort.signal.aborted)setError(message(error))}};void read();const timer=window.setInterval(()=>void read(),5000);return()=>{abort.abort();window.clearInterval(timer)}},[prefix,before,id,visible,expanded,busy])
  const run=async(resume:boolean)=>{
    if(!file){setError('请先选择本机文件；恢复时重新选择原文件。');return}
    if(!resume&&!portableUploadName(name)){setError('请使用不含路径、隐藏前缀或保留符号的可移植文件名（最多 240 个 UTF-8 字节）。');return}
    const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setPhase('正在核对本机文件分块清单');setHashed(0)
    try{
      const manifest=await sourceManifest(file,abort.signal,done=>setHashed(done));let current:DataUpload
      if(resume){if(!id)throw new Error('请选择待恢复的导入记录');current=await api<DataUpload>(`${prefix}document?id=${encodeURIComponent(id)}`,undefined,abort.signal);if(file.size!==current.bytes||manifest.manifestSha256!==current.manifestSha256)throw new Error('当前所选文件与原上传清单不同，不能继续此记录')}
      else{const request={directory,name,bytes:file.size,chunkHashes:manifest.chunkHashes,...(expected.trim()?{expectedSha256:expected.trim()}:{})};const key=JSON.stringify(request);if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};current=await api<DataUpload>(`${prefix}start`,{confirmed:true,upload:{...request,operationId:operation.current.id}},abort.signal)}
      setRecord(current);setId(current.id);setPhase('正在传输或核验完整文件');const result=await transferUpload(projectId,current,file,abort.signal,setRecord)
      if(result.state==='completed'){setPhase('已校验并导入；加载数据仍需单独批准');await committed()}else setPhase(`服务端状态：${result.state}`)
      await list()
    }catch(error){if(abort.signal.aborted)setPhase('已暂停。服务端保存已确认的分块；继续前会重新核对本机文件。');else{setError(message(error));setPhase('传输未确认；请读取记录后继续，勿另起重复导入。')}}finally{if(controller.current===abort)controller.current=undefined;setBusy(false)}
  }
  const cancel=async()=>{if(!record)return;setBusy(true);setError('');try{if(!window.confirm('取消此次导入并删除私有暂存？不会删除项目中已有的文件。'))return;setRecord(await api(`${prefix}cancel`,{id:record.id,confirmed:true}));setPhase('已取消，未删除项目文件');await list()}catch(error){setError(message(error))}finally{setBusy(false)}}
  return <section aria-label="导入项目数据"><details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>导入文件与断点续传</summary><p>文件先进入本项目私有暂存区，逐块校验并计算完整 SHA-256 后发布。每文件最多 10 GiB；同名文件不会覆盖。文件内容不会发送到云端，导入不会执行或自动加载代码。</p>
    {error&&<p role="alert" className="oss-error">{error}</p>}<p>新导入目录：<code>/{directory}</code></p>
    <label>本机数据文件<input type="file" aria-label="本机导入文件" disabled={busy} onChange={event=>{const chosen=event.target.files?.[0];setFile(chosen);if(chosen)setName(chosen.name);setHashed(0)}} /></label>
    <label>新导入文件名<input aria-label="导入目标文件名" maxLength={240} value={name} disabled={busy} onChange={event=>setName(event.target.value)} /></label>
    <label>独立来源的完整 SHA-256（可选）<input aria-label="导入预期完整 SHA-256" maxLength={64} value={expected} disabled={busy} onChange={event=>setExpected(event.target.value)} /></label><p><small>不填写时，服务端仍逐块比对本机清单并记录完整文件哈希。哈希证明字节对应关系，不证明科学有效性。恢复时以原记录的目标与预期哈希为准。</small></p>
    <div className="oss-toolbar"><button className="oss-primary" disabled={busy||!file||!name.trim()} onClick={()=>void run(false)}>批准导入新文件</button><button disabled={!busy} onClick={()=>controller.current?.abort()}>暂停本次传输</button><button disabled={busy||!file||!record||record.state!=='uploading'} onClick={()=>void run(true)}>核对原文件并继续导入</button></div>
    <p aria-live="polite">{phase}{busy&&file?` · 本机清单 ${Math.round((file.size?hashed/file.size:1)*100)}%`:''}</p>
    <div className="oss-toolbar"><button disabled={busy||!before} onClick={()=>setBefore(undefined)}>导入第一页</button><button disabled={busy||!page.next} onClick={()=>setBefore(page.next)}>更早的导入记录</button></div>
    <label>项目导入记录<select aria-label="项目导入记录" disabled={busy} value={id} onChange={event=>{setId(event.target.value);setRecord(undefined)}}><option value="">选择记录</option>{id&&!page.entries.some(item=>item.id===id)&&<option value={id}>当前导入 · {id}</option>}{page.entries.map(item=><option value={item.id} key={item.id}>{item.target} · {item.state} · {item.received}/{item.bytes} B</option>)}</select></label>
    <div className="oss-toolbar"><label>按完整导入编号读取<input aria-label="导入记录编号" maxLength={150} disabled={busy} value={lookup} onChange={event=>setLookup(event.target.value)} /></label><button disabled={busy||!lookup.trim()} onClick={()=>{setId(lookup.trim());setRecord(undefined)}}>读取指定导入</button></div>
    {record&&<section aria-label="数据导入详情"><strong>导入状态：<span data-upload-state>{record.state}</span></strong><p>目标 <code>{record.target}</code><br />已确认字节 <span data-upload-received>{record.received}</span> / {record.bytes}<br />编号 <code>{record.id}</code></p>{record.error&&<p className="oss-note">{record.error}</p>}{record.sha256&&<p>{record.state==='completed'?'提交时完整 SHA-256':'已核验 SHA-256（尚未确认提交）'}：<code data-upload-sha256>{record.sha256}</code></p>}<details><summary>来源分块清单与导入收据</summary><pre>{JSON.stringify({id:record.id,target:record.target,state:record.state,bytes:record.bytes,received:record.received,chunkSize:record.chunkSize,manifestSha256:record.manifestSha256,expectedSha256:record.expectedSha256,sha256:record.sha256,createdAt:record.createdAt,updatedAt:record.updatedAt},null,2)}</pre></details><button disabled={busy||record.state==='completed'||record.state==='canceled'} onClick={()=>void cancel()}>取消导入并清理暂存</button><p><small>提交后文件属于项目，可被后续分析修改；收据记录导入时的字节，不自动认证当前文件内容。刷新页面后需重新选择同一本机文件才能恢复。</small></p></section>}
  </details></section>
}
