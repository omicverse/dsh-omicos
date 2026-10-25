import { useUnsavedNavigation } from './unsaved-navigation.js'
import { useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { Execution } from '../oss/types.js'
import type { ResearchDefinition, ResearchPlan, PlanDecision, PlanEvidenceSource } from '../oss/research-plan-types.js'
type Entry = { id: string; revision: number; title: string; status: string; steps: number; completed: number; skipped: number; updatedAt: string }
type Page = { entries: Entry[]; next?: number }
type History = { revisions: ResearchPlan[]; next?: number }
const example = (): ResearchDefinition => ({ title: '新科研计划', objective: '描述研究问题、数据范围和预期结果。', steps: [{ id: 'inspect-inputs', title: '核对输入与对象状态', inputs: ['当前项目的数据路径与对象'], outputs: ['输入检查记录'], methods: ['填写方法名称、版本及来源'], risk: '不修改原始数据；先核对是否已经归一化。', acceptance: '实际检查记录包含样本数、特征数、缺失值与处理状态。' }] })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function ResearchPlanPane({ projectId, visible, executions }: { projectId: string; visible: boolean; executions: Execution[] }): JSX.Element {
  const prefix = `project/${projectId}/research-plan-`
  const [page, setPage] = useState<Page>({ entries: [] }); const [before, setBefore] = useState<number>(); const [query, setQuery] = useState('')
  const [plan, setPlan] = useState<ResearchPlan>(); const identity = useRef(''); const [draft, setDraft] = useState(() => JSON.stringify(example(), null, 2)); const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState(''); const [lookup, setLookup] = useState('')
  const [history, setHistory] = useState<History>({ revisions: [] }); const [compare, setCompare] = useState<ResearchPlan>()
  const [evidenceKind, setEvidenceKind] = useState<'project' | 'pipeline'>('project'); const [executionId, setExecutionId] = useState(''); const [runId, setRunId] = useState('')
  const operation = useRef<{ key: string; id: string }>()
  const operationId = (request: unknown) => { const key = JSON.stringify(request); if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() }; return operation.current.id }
  const adopt = (document: ResearchPlan) => { identity.current = document.id; setPlan(document); setDraft(JSON.stringify(document.definition, null, 2)); setDirty(false); setHistory({ revisions: [] }); setCompare(undefined); setNote('') }
  const discard = () => !dirty || window.confirm('当前计划有未保存修改，确定放弃这些修改？')
  const action = async (task: () => Promise<void>) => { setBusy(true); setError(''); try { await task() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  const reloadPage = async () => { const params = new URLSearchParams({ q: query }); if (before) params.set('before', String(before)); setPage(await api<Page>(`${prefix}list?${params}`)) }
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(); const params = new URLSearchParams({ q: query }); if (before) params.set('before', String(before))
    const read = () => void api<Page>(`${prefix}list?${params}`, undefined, controller.signal).then(result => { if (!controller.signal.aborted) setPage(result) }).catch(error => { if (!controller.signal.aborted) setError(message(error)) })
    read(); const timer = window.setInterval(read, 10000); return () => { controller.abort(); window.clearInterval(timer) }
  }, [prefix, before, query, visible])
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard) }, [dirty])
  const open = (id: string) => { if (!discard()) return; void action(async () => { const result = await api<ResearchPlan>(`${prefix}document?id=${encodeURIComponent(id)}`); adopt(result) }) }
  const save = () => void action(async () => {
    const definition = JSON.parse(draft); const request = { ...(plan ? { id: plan.id, revision: plan.revision } : {}), definition }
    const result = await api<ResearchPlan>(`${prefix}propose`, { plan: { ...request, operationId: operationId(request) } }); adopt(result); await reloadPage()
  })
  const decide = (decision: PlanDecision['action'], stepId?: string) => void action(async () => {
    if (!plan || dirty) throw new Error('请先保存当前计划，再核对固定版本')
    const evidence: PlanEvidenceSource[] = executionId.trim() && ['complete','block'].includes(decision) ? [{ kind: evidenceKind, executionId: executionId.trim(), ...(evidenceKind === 'pipeline' ? { runId: runId.trim() } : {}) }] : []
    const request = { id: plan.id, revision: plan.revision, action: decision, note, ...(stepId ? { stepId } : {}), evidence }
    const result = await api<ResearchPlan>(`${prefix}decide`, { confirmed: true, decision: { ...request, operationId: operationId(request) } }); adopt(result); await reloadPage()
  })
  const loadHistory = () => { if (!plan) return; const id = plan.id; const cursor = history.next; void action(async () => { const result = await api<History>(`${prefix}history?id=${encodeURIComponent(id)}${cursor ? `&before=${cursor}` : ''}`); if (identity.current === id) setHistory(current => ({ revisions: cursor ? current.revisions.concat(result.revisions) : result.revisions, next: result.next })) }) }
  const disabled = busy || dirty || !note.trim()
  const navigationRef = useUnsavedNavigation(dirty, '科研计划')
  return <article ref={navigationRef} className="oss-card" aria-label="科研计划"><div className="oss-row"><div><small>RESEARCH PLANS</small><h2>科研计划与人工审批</h2></div><span className="oss-chip">版本 · 验收条件 · 执行证据</span></div>
    <p>先固定研究目标、方法、输入输出与风险，再由你批准。计划审批不会自动执行或代替代码审批；完成记录是你的验收意见，执行成功不代表科学结论有效。</p>
    {error && <p role="alert" className="oss-error">{error}</p>}
    <div className="oss-toolbar"><label>搜索科研计划<input aria-label="搜索科研计划" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setBefore(undefined) }} /></label><button disabled={busy || !before} onClick={() => setBefore(undefined)}>计划第一页</button><button disabled={busy || !page.next} onClick={() => setBefore(page.next)}>更早的科研计划</button><small>此页 {page.entries.length} 个</small></div>
    <div className="oss-toolbar"><label>项目科研计划<select aria-label="项目科研计划" disabled={busy} value={plan?.id || ''} onChange={event => { if (event.target.value) open(event.target.value) }}><option value="">新计划</option>{plan && !page.entries.some(item => item.id === plan.id) && <option value={plan.id}>当前计划 · {plan.definition.title}</option>}{page.entries.map(item => <option key={item.id} value={item.id}>{item.title} · {item.status} · 完成 {item.completed}/{item.steps} · 跳过 {item.skipped}</option>)}</select></label><button disabled={busy} onClick={() => { if (discard()) { identity.current = ''; setPlan(undefined); setDraft(JSON.stringify(example(), null, 2)); setDirty(false); setHistory({ revisions: [] }); setCompare(undefined); setNote('') } }}>新建科研计划</button><button disabled={busy || !plan} onClick={() => plan && open(plan.id)}>重新读取当前计划</button></div>
    <div className="oss-toolbar"><label>按计划编号打开<input aria-label="科研计划编号" maxLength={150} value={lookup} onChange={event => setLookup(event.target.value)} /></label><button disabled={busy || !lookup.trim()} onClick={() => open(lookup.trim())}>按编号打开科研计划</button></div>
    <details><summary>计划字段与审批规则</summary><p>definition 包含 title、objective 和 1–100 个有唯一 id 的 steps。每步包含 title、inputs、outputs、methods、risk、acceptance。方法引用请写明版本与来源；这些字段是声明，不会自动验证或读取文件。任何编辑都回到草案并清除当前批准与任务验收，原修订仍保留。</p></details>
    <label>科研计划定义（JSON）<textarea className="oss-code" aria-label="科研计划定义 JSON" spellCheck={false} value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setDirty(true) }} /></label>
    <button disabled={busy || (Boolean(plan) && !dirty)} onClick={save}>保存科研计划草案</button>
    {plan && <section aria-label="科研计划详情"><div className="oss-row"><strong>计划状态：<span data-research-plan-state>{plan.status}</span></strong><small>修订 {plan.revision}</small></div><p>编号 <code>{plan.id}</code><br />定义 SHA-256 <code>{plan.definitionSha256}</code></p>{dirty && <p className="oss-note">当前编辑尚未保存，审批和验收已暂时禁用。</p>}
      <label>本次人工决定的理由或验收意见<textarea aria-label="科研计划决定说明" maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></label>
      <div className="oss-toolbar"><button className="oss-primary" disabled={disabled || plan.status !== 'draft'} onClick={() => decide('approve')}>批准此版本科研计划</button><button disabled={disabled || plan.status !== 'draft'} onClick={() => decide('reject')}>拒绝此计划</button><button disabled={disabled || plan.status === 'withdrawn'} onClick={() => decide('withdraw')}>撤回此计划</button></div>
      {plan.approval && <p className="oss-note">批准人 {plan.approval.actor} · {plan.approval.at} · {plan.approval.note}</p>}
      <details><summary>选择任务验收的执行证据</summary><label>证据来源<select aria-label="计划证据来源" value={evidenceKind} onChange={event => { setEvidenceKind(event.target.value as 'project' | 'pipeline'); setExecutionId(''); setRunId('') }}><option value="project">项目 Python / R 执行</option><option value="pipeline">Pipeline 执行</option></select></label>{evidenceKind === 'project' && <label>最近成功执行<select aria-label="计划最近执行证据" value={executionId} onChange={event => setExecutionId(event.target.value)}><option value="">选择或填写历史编号</option>{executionId && !executions.some(item => item.id === executionId && item.state === 'succeeded') && <option value={executionId}>指定执行 · {executionId}</option>}{executions.filter(item => item.state === 'succeeded').slice().reverse().map(item => <option value={item.id} key={item.id}>{item.language} · {item.id.slice(0,8)} · {item.code.slice(0,70)}</option>)}</select></label>}<label>完整执行编号<input aria-label="计划执行证据编号" maxLength={150} value={executionId} onChange={event => setExecutionId(event.target.value)} /></label>{evidenceKind === 'pipeline' && <label>Pipeline 运行编号<input aria-label="计划 Pipeline 证据运行编号" maxLength={150} value={runId} onChange={event => setRunId(event.target.value)} /></label>}<p>服务端读取原始收据并记录代码、输出、环境与产物哈希。文件与方法的声明不会因此变成已验证来源。</p></details>
      {plan.definition.steps.map((step,index) => { const assessment = plan.assessments.find(item => item.stepId === step.id); const locked = disabled || plan.status !== 'approved'; return <section className="oss-variable" key={step.id}><h3>{index+1}. {step.title} · {assessment?.state || '待验收'}</h3><p>{step.acceptance}</p><details><summary>输入、方法、输出与风险</summary><pre>{JSON.stringify(step, null, 2)}</pre></details>{assessment && <><p>{assessment.note}</p><details><summary>固定的验收证据</summary><pre>{JSON.stringify(assessment, null, 2)}</pre></details></>}<div className="oss-toolbar"><button disabled={locked || !executionId.trim() || (evidenceKind === 'pipeline' && !runId.trim()) || Boolean(assessment && assessment.state !== 'blocked')} onClick={() => decide('complete', step.id)}>凭执行证据确认完成</button><button disabled={locked || Boolean(assessment && assessment.state !== 'blocked')} onClick={() => decide('block', step.id)}>记录阻塞</button><button disabled={locked || Boolean(assessment && assessment.state !== 'blocked')} onClick={() => decide('skip', step.id)}>明确跳过</button><button disabled={locked || !assessment} onClick={() => decide('reopen', step.id)}>重开此步及后续验收</button></div></section> })}
      <button disabled={busy} onClick={loadHistory}>{history.revisions.length ? history.next ? '更早的计划修订' : '刷新计划修订' : '读取计划修订历史'}</button>
      {history.revisions.length > 0 && <details open><summary>不可变计划修订 · {history.revisions.length} 条</summary>{history.revisions.map(revision => <div className="oss-variable" key={revision.revision}><button disabled={busy} onClick={() => setCompare(revision)}>查看修订 {revision.revision}</button><span> {revision.action}{revision.decisionStepId ? ` (${revision.decisionStepId})` : ''} · {revision.status} · {revision.updatedAt}</span><p>{revision.note}</p></div>)}</details>}
      {compare && <details open><summary>历史修订 {compare.revision}（只读）</summary><pre>{JSON.stringify(compare, null, 2)}</pre></details>}
    </section>}
  </article>
}
