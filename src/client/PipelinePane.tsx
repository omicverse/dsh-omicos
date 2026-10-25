import {PipelineHistory} from './PipelineHistory.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { PipelineDefinition, PipelineRunWindow, PipelineEvent, PipelineRunSummary, PipelineReference } from '../oss/pipeline-types.js'
import type { Execution } from '../oss/types.js'
type MethodChoice = { id: string; key: string; version: string; title: string }
type RunSummary = PipelineRunSummary
interface Listing { definitions: Array<{ id: string; title: string; language: string; steps: number }>; runs: RunSummary[]; definitionPage?: { total: number; next?: number }; runPage?: { total: number; next?: number } }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function example(language: 'python' | 'r' = 'python'): string {
  const checkpoint = `pipeline-${crypto.randomUUID().slice(0, 8)}.json`
  return JSON.stringify({ title: '示例：检查点与人工关卡', language, parameters: { base: 40, checkpoint }, inputs: [], references: [], steps: [
    { id: 'prepare', title: '保存可恢复的计算状态', code: language === 'python' ? 'import json\nfrom pathlib import Path\nvalue = pipeline_parameters["base"]\nwith open(pipeline_parameters["checkpoint"], "x") as handle:\n    json.dump({"value": value}, handle)\nprint(value)' : 'value <- pipeline_parameters$base\nif (file.exists(pipeline_parameters$checkpoint)) stop("Checkpoint already exists; inspect it first")\njsonlite::write_json(list(value=value), pipeline_parameters$checkpoint)\nprint(value)', checkpoint: { files: [checkpoint], restoreCode: language === 'python' ? 'import json\nvalue = json.loads(open(pipeline_parameters["checkpoint"]).read())["value"]' : 'value <- jsonlite::read_json(pipeline_parameters$checkpoint)$value' } },
    { id: 'report', title: '核对后继续生成结果', gate: true, code: language === 'python' ? 'print(value + 2)' : 'print(value + 2)' },
  ] }, null, 2)
}
export function PipelinePane({ projectId, visible }: { projectId: string; visible: boolean }): JSX.Element {
  const prefix = `project/${projectId}/`
  const [listing, setListing] = useState<Listing>({ definitions: [], runs: [] })
  const [definitionsBefore, setDefinitionsBefore] = useState<number>(); const [runsBefore, setRunsBefore] = useState<number>()
  const [definitionQuery, setDefinitionQuery] = useState(''); const [runQuery, setRunQuery] = useState(''); const [stateFilter, setStateFilter] = useState('')
  const [runLookup, setRunLookup] = useState(''); const [definitionLookup, setDefinitionLookup] = useState('')
  const [methodId, setMethodId] = useState(''); const [methodChoices, setMethodChoices] = useState<MethodChoice[]>([])
  const [draft, setDraft] = useState(() => example())
  const [definitionId, setDefinitionId] = useState('')
  const [dirty, setDirty] = useState(true)
  const [touched, setTouched] = useState(false)
  const [runId, storeRunId] = useState('')
  const runIdentity = useRef(runId); runIdentity.current = runId
  const setRunId = (id: string) => { runIdentity.current = id; storeRunId(id) }
  const [run, setRun] = useState<PipelineRunWindow>()
  const [runDefinition, setRunDefinition] = useState<PipelineDefinition>()
  const [checkpoint, setCheckpoint] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [acceptEnvironment, setAcceptEnvironment] = useState(false)
  const eventCursor=useRef(0)
  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [receipt, setReceipt] = useState<Execution>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pendingStart = useRef<{ definitionId: string; operationId: string }>()
  useEffect(() => {
    if (!dirty || !touched) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, touched])
  const readMethods = async () => setMethodChoices((await api<{entries:MethodChoice[]}>(`${prefix}method-list?state=published`)).entries)
  useEffect(() => { if (!visible) return; const controller = new AbortController(); void api<{entries:MethodChoice[]}>(`${prefix}method-list?state=published`,undefined,controller.signal).then(result => { if(!controller.signal.aborted)setMethodChoices(result.entries) }).catch(error => { if(!controller.signal.aborted)setError(message(error)) }); return () => controller.abort() }, [prefix,visible])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ definitionQuery, runQuery, state: stateFilter }); if (definitionsBefore) query.set('definitionsBefore', String(definitionsBefore)); if (runsBefore) query.set('runsBefore', String(runsBefore))
    const listing = await api<Listing>(`${prefix}pipelines?${query}`, undefined, signal)
    if (!signal?.aborted) setListing(listing)
    if (runId) { const latest = await api<PipelineRunWindow>(`${prefix}pipeline-run?view=window&run=${encodeURIComponent(runId)}`, undefined, signal); if (!signal?.aborted && runIdentity.current === runId) setRun(latest) }
  }, [prefix, runId, definitionsBefore, runsBefore, definitionQuery, runQuery, stateFilter])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    const load = () => { if (!document.hidden) void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(message(error)) }) }
    load(); const timer = setInterval(load, 2500)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh, visible])
  useEffect(() => {
    setCheckpoint(''); setReviewed(false); setAcceptEnvironment(false); setEvents([]);eventCursor.current=0; setReceipt(undefined)
    if (!run?.definitionId) { setRunDefinition(undefined); return }
    let alive = true; setRunDefinition(undefined)
    void api<PipelineDefinition>(`${prefix}pipeline-definition?id=${encodeURIComponent(run.definitionId)}`).then(definition => { if (alive) setRunDefinition(definition) }, error => { if (alive) setError(message(error)) })
    return () => { alive = false }
  }, [prefix, run?.definitionId, runId])
  const action = async (callback: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await callback() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  const openDefinition = (id: string) => void action(async () => {
    if (dirty && touched && !window.confirm('放弃当前未保存的 Pipeline 定义？')) return
    const definition = await api<PipelineDefinition>(`${prefix}pipeline-definition?id=${encodeURIComponent(id)}`)
    setDefinitionId(definition.id); setDraft(JSON.stringify(definition, null, 2)); setDirty(false); setTouched(false)
  })
  const save = () => void action(async () => {
    const definition = await api<PipelineDefinition>(`${prefix}pipeline-define`, { definition: JSON.parse(draft) })
    setDefinitionId(definition.id); setDraft(JSON.stringify(definition, null, 2)); setDirty(false); setTouched(false); await refresh()
  })
  const start = () => void action(async () => {
    if (dirty || !definitionId) throw new Error('请先保存并核对固定定义')
    const operation = pendingStart.current?.definitionId === definitionId ? pendingStart.current : { definitionId, operationId: crypto.randomUUID() }
    pendingStart.current = operation
    const accepted = await api<PipelineRunWindow>(`${prefix}pipeline-start`, { ...operation, confirmed: true,windowed:true })
    pendingStart.current = undefined; setRunId(accepted.id); setRun(accepted); await refresh()
  })
  const control = (kind: 'continue' | 'checkpoint' | 'restart' | 'cancel' | 'reject') => void action(async () => {
    if (!run) return
    const updated = await api<PipelineRunWindow>(`${prefix}pipeline-control`, { runId: run.id, revision: run.revision, action: kind,windowed:true, checkpointAttemptId: checkpoint || undefined, sideEffectsReviewed: reviewed, allowEnvironmentChange: acceptEnvironment, confirmed: true })
    setRun(updated); setReviewed(false); setAcceptEnvironment(false); await refresh()
  })
  const known = runDefinition?.id === run?.definitionId
  const recoverable = run && ['waiting', 'failed', 'canceled', 'interrupted'].includes(run.state)
  return <article className="oss-card oss-pipeline" aria-label="Pipeline 工作流"><div className="oss-row"><div><small>PINNED SCIENTIFIC WORKFLOWS</small><h2>Pipeline</h2></div><span className="oss-chip">独立内核 · 检查点 · 人工关卡</span></div>
    <p>把分析固定为有版本的步骤。每次运行使用独立 Python/R 进程，工作目录仍是当前项目。定义保存不会执行；批准运行后按顺序执行，人工关卡会暂停。恢复不会假装已丢失的变量仍在。</p>
    {error && <p role="alert" className="oss-error">{error}</p>}
    <div className="oss-toolbar"><label>查找固定定义<input aria-label="查找 Pipeline 定义" value={definitionQuery} maxLength={200} onChange={event => { setDefinitionQuery(event.target.value); setDefinitionsBefore(undefined) }} /></label><button disabled={busy || !definitionsBefore} onClick={() => setDefinitionsBefore(undefined)}>定义第一页</button><button disabled={busy || !listing.definitionPage?.next} onClick={() => setDefinitionsBefore(listing.definitionPage?.next)}>更早的固定定义</button><small>固定定义共 {listing.definitionPage?.total ?? listing.definitions.length} 个 · 此页 {listing.definitions.length} 个</small></div>
    <div className="oss-toolbar"><label>按固定定义 SHA-256 打开<input aria-label="Pipeline 定义编号" value={definitionLookup} maxLength={64} onChange={event => setDefinitionLookup(event.target.value)} /></label><button disabled={busy || !definitionLookup.trim()} onClick={() => openDefinition(definitionLookup.trim())}>按编号打开固定定义</button></div>
    <div className="oss-toolbar"><label>固定定义<select aria-label="Pipeline 固定定义" value={definitionId} disabled={busy} onChange={event => { if (event.target.value) openDefinition(event.target.value) }}><option value="">编辑新定义</option>{definitionId && !listing.definitions.some(item => item.id === definitionId) && <option value={definitionId}>当前固定定义 · {definitionId.slice(0, 12)}</option>}{listing.definitions.map(definition => <option key={definition.id} value={definition.id}>{definition.title} · {definition.language} · {definition.id.slice(0, 8)}</option>)}</select></label><button disabled={busy} onClick={() => { if (!dirty || !touched || window.confirm('替换未保存的定义为 Python 示例？')) { setDraft(example('python')); setDefinitionId(''); setDirty(true); setTouched(false) } }}>Python 示例</button><button disabled={busy} onClick={() => { if (!dirty || !touched || window.confirm('替换未保存的定义为 R 示例？')) { setDraft(example('r')); setDefinitionId(''); setDirty(true); setTouched(false) } }}>R 示例</button></div>
    <details><summary>加入已发布方法引用</summary><p>只把精确原文/版本/哈希加入当前草案，保留现有步骤与参数。保存和运行时会重新检查本项目的方法发布状态。</p><label>已发布科研方法<select aria-label="Pipeline 已发布科研方法" value={methodId} disabled={busy} onChange={event=>setMethodId(event.target.value)}><option value="">选择或填写内容编号</option>{methodId&&!methodChoices.some(item=>item.id===methodId)&&<option value={methodId}>指定方法 · {methodId.slice(0,12)}</option>}{methodChoices.map(item=><option key={item.id} value={item.id}>{item.key}@{item.version} · {item.title}</option>)}</select></label><label>精确方法内容编号<input aria-label="Pipeline 方法内容编号" maxLength={64} value={methodId} onChange={event=>setMethodId(event.target.value)} /></label><button disabled={busy} onClick={()=>void action(readMethods)}>刷新已发布方法</button><button disabled={busy||!methodId.trim()} onClick={()=>void action(async()=>{const reference=await api<PipelineReference>(`${prefix}method-reference?id=${encodeURIComponent(methodId.trim())}`);const definition=JSON.parse(draft);if(!definition||typeof definition!=='object'||!Array.isArray(definition.steps)||definition.references!==undefined&&!Array.isArray(definition.references))throw new Error('先修复当前 Pipeline JSON，现有草案不会被替换');const references=(definition.references||[]) as PipelineReference[];const previous=references.find(item=>item.id===reference.id);if(previous&&(previous.version!==reference.version||previous.text!==reference.text||previous.sha256!==reference.sha256))throw new Error('当前草案已有不同内容的同名受管引用，请人工核对');if(previous)return;references.push(reference);definition.references=references;delete definition.id;setDraft(JSON.stringify(definition,null,2));setDirty(true);setTouched(true)})}>把此方法加入当前 Pipeline 草案</button></details>
    <details><summary>定义格式与恢复约束</summary><p>parameters 是固定的 JSON 参数，代码可通过 pipeline_parameters 读取；inputs/outputs 为项目内相对文件路径。checkpoint.files 指定持久文件，restoreCode 明确恢复内存状态。references 可嵌入带版本和 SHA-256 的方法或 Skill 原文。编辑任何绑定、引用或代码都会生成新定义。</p><p>运行拥有当前 OS 用户权限。文件哈希与执行成功不代表科学结论有效。取消、失败或中断可能留下文件变化；重跑或恢复前需要核对这些副作用。恢复时会核验输入、检查点和实际环境，不会自动安装依赖。</p></details>
    <label>Pipeline 定义（JSON）<textarea aria-label="Pipeline 定义 JSON" className="oss-code" spellCheck={false} value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setDirty(true); setTouched(true) }} /></label>
    <div className="oss-row"><div><button disabled={busy || !dirty} onClick={save}>保存固定定义</button><button className="oss-primary" disabled={busy || dirty || !definitionId} onClick={start}>批准运行此定义</button></div><small>{dirty ? '修改尚未固定，不能运行' : `sha256: ${definitionId}`}</small></div>
    <h3>运行与恢复</h3><div className="oss-toolbar"><label>查找运行<input aria-label="查找 Pipeline 运行" value={runQuery} maxLength={200} onChange={event => { setRunQuery(event.target.value); setRunsBefore(undefined) }} /></label><label>运行状态<select aria-label="筛选 Pipeline 状态" value={stateFilter} onChange={event => { setStateFilter(event.target.value); setRunsBefore(undefined) }}><option value="">全部</option>{['preparing','running','waiting','cancelling','canceled','failed','interrupted','succeeded'].map(state => <option key={state} value={state}>{state}</option>)}</select></label><button disabled={busy || !runsBefore} onClick={() => setRunsBefore(undefined)}>运行第一页</button><button disabled={busy || !listing.runPage?.next} onClick={() => setRunsBefore(listing.runPage?.next)}>更早的 Pipeline 运行</button><small>运行共 {listing.runPage?.total ?? listing.runs.length} 次 · 此页 {listing.runs.length} 次</small></div>
    <div className="oss-toolbar"><label>按完整运行编号打开<input aria-label="Pipeline 运行编号" value={runLookup} maxLength={100} onChange={event => setRunLookup(event.target.value)} /></label><button disabled={busy || !runLookup.trim()} onClick={() => void action(async () => { const opened = await api<PipelineRunWindow>(`${prefix}pipeline-run?view=window&run=${encodeURIComponent(runLookup.trim())}`); setRunId(opened.id); setRun(opened) })}>按编号打开 Pipeline 运行</button></div>
<label>项目运行<select aria-label="Pipeline 运行" value={runId} disabled={busy} onChange={event => { setRunId(event.target.value); setRun(undefined) }}><option value="">选择运行</option>{runId && !listing.runs.some(item => item.id === runId) && <option value={runId}>当前运行 · {run?.state || '读取中'} · {runId.slice(0, 8)}</option>}{listing.runs.map(item => <option value={item.id} key={item.id}>{item.title || item.definitionId.slice(0, 8)} · {item.state} · {new Date(item.createdAt).toLocaleString()} · {item.id.slice(0, 8)}</option>)}</select></label>
    {run && <section aria-label="Pipeline 运行详情"><div className="oss-row"><strong>状态：<span data-pipeline-state>{run.state}</span></strong><small>修订 {run.revision} · 尝试批次 {run.epoch}</small><button disabled={busy} onClick={() => void action(() => refresh())}>刷新运行状态</button></div><p>运行 <code>{run.id}</code><br />固定定义 <code>{run.definitionId}</code><br />阶段 {Math.min(run.nextStep + 1, runDefinition?.steps.length || run.nextStep + 1)} / {runDefinition?.steps.length || '…'}：{runDefinition?.steps[run.nextStep]?.title || (run.state === 'succeeded' ? '已完成全部步骤' : '正在读取固定定义')}</p>{run.reason && <p className="oss-note">{run.reason}</p>}
      <details><summary>本次运行固定的代码与绑定</summary><pre>{known ? JSON.stringify(runDefinition, null, 2) : '正在读取本次运行的固定定义…'}</pre></details>
      <details><summary>环境与输入证据</summary><pre>{JSON.stringify({ environment: run.environment, inputs: run.inputs, recoveries: run.recoveries, totals:run.counts,notice:"仅显示最近 20 条检查点/恢复摘要；更多记录请使用分页历史" }, null, 2)}</pre></details>
      {run.state === 'waiting' && <div><button className="oss-primary" disabled={busy || !known} onClick={() => control('continue')}>批准此阶段并继续</button><button disabled={busy} onClick={() => control('reject')}>拒绝此阶段</button></div>}
      {!['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.state) && <button disabled={busy} onClick={() => control('cancel')}>取消 Pipeline 运行</button>}
      {recoverable && <section className="oss-confirm"><h3>明确选择恢复方式</h3><p>检查点恢复会新建内核并运行固定的 restoreCode；从头执行可能重复文件与外部副作用。若原内核已丢失，不能直接继续。</p><label>检查点<select aria-label="Pipeline 检查点" value={checkpoint} onChange={event => setCheckpoint(event.target.value)}><option value="">选择已完成的检查点</option>{checkpoint&&!run.checkpoints.some(item=>item.attemptId===checkpoint)&&<option value={checkpoint}>已选历史检查点 · {checkpoint}</option>}{run.checkpoints.filter(item => item.step < run.nextStep).map(item => <option key={item.attemptId} value={item.attemptId}>阶段 {item.step + 1} · {item.files} 个固定文件 · {item.attemptId.slice(0, 8)}</option>)}</select></label><label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />我已检查上次执行可能留下的文件、数据与外部副作用</label><label><input type="checkbox" checked={acceptEnvironment} onChange={event => setAcceptEnvironment(event.target.checked)} />已核对环境差异，允许在变化后的环境恢复或重跑</label><button disabled={busy || !known || !reviewed || !checkpoint} onClick={() => control('checkpoint')}>批准恢复所选检查点</button><button disabled={busy || !known || !reviewed} onClick={() => control('restart')}>批准从头重新执行</button></section>}
      <PipelineHistory key={run.id} projectId={projectId} runId={run.id} onCheckpoint={id=>{setCheckpoint(id);setReviewed(false);setAcceptEnvironment(false)}} onExecution={id=>void action(async()=>{const expected=run.id;const result=await api<Execution>(`${prefix}pipeline-execution?run=${encodeURIComponent(expected)}&execution=${encodeURIComponent(id)}`);if(runIdentity.current===expected)setReceipt(result)})}/><h3>执行收据（最近 20 次 / 共 {run.counts.attempts} 次）</h3><p>以下为每次最多 1,000 字符的摘要；完整输出与图表按需读取，旧尝试可从分页历史打开。</p>{run.attempts.map(attempt => <div className="oss-variable" key={attempt.id}><div className="oss-row"><strong>{attempt.kind === 'restore' ? '恢复' : '阶段'} {attempt.step + 1} · {attempt.state}</strong>{attempt.executionId && <button onClick={() => void action(async () => { setReceipt(await api<Execution>(`${prefix}pipeline-execution?run=${encodeURIComponent(run.id)}&execution=${encodeURIComponent(attempt.executionId!)}`)) })}>读取完整收据</button>}</div><code>{attempt.executionId || attempt.operationId}</code>{attempt.outputTail && <pre className="oss-output">{attempt.outputTail}</pre>}{attempt.error && <pre className="oss-error">{attempt.error}</pre>}<small>固定文件 {attempt.files} 个 · 图表产物 {attempt.artifacts} 个；通过完整收据查看输出。</small></div>)}
      {receipt && <details open><summary>完整执行收据 · {receipt.id} · {receipt.state}</summary><pre>{receipt.code}</pre><pre className="oss-output">{receipt.output}</pre>{receipt.error && <pre className="oss-error">{receipt.error}</pre>}{receipt.artifacts.map(artifact=>{const url=`/omicos/oss/api/${prefix}pipeline-artifact?run=${encodeURIComponent(run.id)}&execution=${encodeURIComponent(receipt.id)}&id=${encodeURIComponent(artifact.id)}`;return <figure key={artifact.id}><a href={url} target="_blank" rel="noreferrer">{artifact.mime==='image/png'?<img src={url} alt="Pipeline 图表"/>:'下载图表文件 ↗'}</a><figcaption>{artifact.path} · sha256 {artifact.sha256}</figcaption></figure>})}</details>}
      <button disabled={busy} onClick={() => void action(async () => { const data = await api<{ events: PipelineEvent[] }>(`${prefix}pipeline-events?run=${encodeURIComponent(run.id)}&after=${eventCursor.current}`); eventCursor.current=data.events.at(-1)?.seq??eventCursor.current;setEvents(data.events) })}>读取下一页运行日志</button>{events.length > 0 && <details open><summary>恢复日志 · {events.length} 条</summary><pre>{events.map(event => `${event.seq} ${event.at} ${event.type} ${JSON.stringify(event.data)}`).join('\n')}</pre></details>}
    </section>}
  </article>
}
