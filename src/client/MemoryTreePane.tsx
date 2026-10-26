import { useUnsavedNavigation } from './unsaved-navigation.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { MemoryDraft, MemoryNode, MemoryView } from '../oss/memory-types.js'
type Summary = Pick<MemoryNode, 'id' | 'title' | 'kind' | 'scope' | 'sessionId' | 'parentId' | 'state' | 'revision' | 'digest'> & { preview: string; effective: boolean; issues: string[] }
interface Listing { entries: Summary[]; next?: number; outline: { topics: Array<Pick<MemoryNode, 'id' | 'title' | 'parentId' | 'state'>>; truncated: boolean } }
const fresh = (): MemoryDraft => ({ title: '', text: '', kind: 'fact', scope: 'project', parentId: null, sources: [{ kind: 'user', ref: 'user:workbench' }], operationId: crypto.randomUUID() })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function MemoryTreePane({ projectId, visible }: { projectId: string; visible: boolean }): JSX.Element {
  const prefix = `project/${projectId}/`
  const [listing, setListing] = useState<Listing>({ entries: [], outline: { topics: [], truncated: false } })
  const [search, setSearch] = useState(''); const [parent, setParent] = useState('all'); const [cursor, setCursor] = useState<number>()
  const [draft, setDraft] = useState<MemoryDraft>(fresh); const [sources, setSources] = useState(() => JSON.stringify(fresh().sources, null, 2))
  const [selected, setSelected] = useState<MemoryView>(); const [checked, setChecked] = useState<string[]>([])
  const [history, setHistory] = useState<{ revisions: MemoryNode[]; next?: number }>({ revisions: [] })
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [promotion, setPromotion] = useState(false); const [consolidate, setConsolidate] = useState(false)
  const pending = useRef<{ body: string; operationId: string }>()
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ q: search }); if (parent !== 'all') query.set('parent', parent); if (cursor) query.set('before', String(cursor))
    const value = await api<Listing>(`${prefix}memory-tree?${query}`, undefined, signal); if (!signal?.aborted) setListing(value)
  }, [prefix, search, parent, cursor])
  useEffect(() => { if (!visible) return; const controller = new AbortController(); const load = () => { if (!document.hidden) void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(message(error)) }) }; load(); const timer = setInterval(load, 5000); return () => { controller.abort(); clearInterval(timer) } }, [refresh, visible])
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard) }, [dirty])
  const action = async (callback: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await callback() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  const loadNode = (node: MemoryNode) => {
    const { id, revision, title, text, kind, scope, sessionId, parentId, sources } = node
    setDraft({ id, revision, title, text, kind, scope, sessionId, parentId, sources, operationId: crypto.randomUUID() }); setSources(JSON.stringify(sources, null, 2)); setDirty(false); setPromotion(false); setConsolidate(false)
  }
  const open = (id: string) => void action(async () => {
    if (dirty && !window.confirm('放弃未保存的记忆提案？')) return
    const view = await api<MemoryView>(`${prefix}memory-node?id=${encodeURIComponent(id)}`)
    setSelected(view); loadNode(view.node); setHistory(await api(`${prefix}memory-history?id=${encodeURIComponent(id)}`))
  })
  const change = (fields: Partial<MemoryDraft>) => { setDraft(value => ({ ...value, ...fields })); setDirty(true) }
  const save = () => void action(async () => {
    const body = JSON.stringify({ ...draft, sources: JSON.parse(sources), operationId: undefined })
    const operation = pending.current?.body === body ? pending.current : { body, operationId: crypto.randomUUID() }; pending.current = operation
    const node = await api<MemoryNode>(`${prefix}memory-propose`, { entry: { ...JSON.parse(body), operationId: operation.operationId } })
    pending.current = undefined; loadNode(node); setSelected(await api(`${prefix}memory-node?id=${encodeURIComponent(node.id)}`)); setHistory(await api(`${prefix}memory-history?id=${encodeURIComponent(node.id)}`)); await refresh()
  })
  const transition = (kind: 'confirm' | 'withdraw' | 'move') => void action(async () => {
    if (!selected || (dirty && kind !== 'move')) throw new Error('先保存并核对当前提案')
    const body = JSON.stringify({ id: selected.node.id, revision: selected.node.revision, action: kind, parentId: draft.parentId, allowScopePromotion: promotion, supersedeSources: consolidate })
    const operation = pending.current?.body === body ? pending.current : { body, operationId: crypto.randomUUID() }; pending.current = operation
    const node = await api<MemoryNode>(`${prefix}memory-transition`, { change: { ...JSON.parse(body), operationId: operation.operationId }, confirmed: true })
    pending.current = undefined; loadNode(node); setSelected(await api(`${prefix}memory-node?id=${encodeURIComponent(node.id)}`)); setHistory(await api(`${prefix}memory-history?id=${encodeURIComponent(node.id)}`)); await refresh()
  })
  const newDraft = () => { if (dirty && !window.confirm('放弃未保存的记忆提案？')) return; const value = fresh(); setDraft(value); setSources(JSON.stringify(value.sources, null, 2)); setSelected(undefined); setHistory({ revisions: [] }); setDirty(false); setPromotion(false); setConsolidate(false) }
  const summarize = () => void action(async () => {
    if (dirty && !window.confirm('放弃未保存的记忆提案？')) return
    const nodes = await Promise.all(checked.map(id => api<MemoryView>(`${prefix}memory-node?id=${encodeURIComponent(id)}`)))
    if (nodes.length < 2 || nodes.some(value => !value.effective || value.node.kind === 'topic')) throw new Error('请选择至少两条当前有效的事实或摘要')
    const value = fresh(); value.kind = 'summary'; value.title = '整合摘要'; value.sources = nodes.map(({ node }) => ({ kind: 'memory', ref: node.id, revision: node.revision, digest: node.digest }))
    setDraft(value); setSources(JSON.stringify(value.sources, null, 2)); setSelected(undefined); setHistory({ revisions: [] }); setDirty(true); setPromotion(false); setConsolidate(false)
  })
  const navigationRef = useUnsavedNavigation(dirty, '记忆提案')
  return <article ref={navigationRef} className="oss-card oss-memory" aria-label="结构化记忆"><div className="oss-row"><div><small>SCOPED RESEARCH MEMORY</small><h2>记忆树</h2></div><button disabled={busy} onClick={newDraft}>新建记忆提案</button></div>
    <p>按主题组织事实、会话笔记和项目内长期记忆。只有已确认且来源仍有效的内容会进入 Agent 上下文。确认代表人工认可，不能代替科学验证；来源变动后摘要需要重新核对。</p>
    {error && <p className="oss-error" role="alert">{error}</p>}
    <div className="oss-toolbar"><label>搜索记忆<input value={search} onChange={event => { setSearch(event.target.value); setCursor(undefined) }} /></label><label>主题筛选<select value={parent} onChange={event => { setParent(event.target.value); setCursor(undefined) }}><option value="all">全部主题</option><option value="root">根目录</option>{listing.outline.topics.map(topic => <option key={topic.id} value={topic.id}>{topic.title} · {topic.state}</option>)}</select></label><button disabled={busy || checked.length < 2} onClick={summarize}>从所选事实建立摘要</button></div>
    {listing.outline.truncated && <p>主题目录超过 500 项；请通过搜索查找其余条目。</p>}
    <div className="oss-memory-layout"><div className="oss-memory-list">{listing.entries.map(entry => <div className="oss-variable" key={entry.id}><div className="oss-row"><label><input type="checkbox" aria-label={`整合 ${entry.title}`} checked={checked.includes(entry.id)} disabled={!entry.effective || entry.kind === 'topic' || busy} onChange={event => setChecked(value => event.target.checked ? [...value, entry.id] : value.filter(id => id !== entry.id))} /> {entry.kind}</label><small>{entry.scope} · r{entry.revision}</small></div><button className="oss-memory-open" disabled={busy} onClick={() => open(entry.id)}>{entry.title}</button><p>{entry.preview}</p><small>{entry.effective ? '已确认 · 当前有效' : entry.state} {entry.issues.join('；')}</small></div>)}{!listing.entries.length && <p>没有符合条件的记忆。</p>}<div className="oss-toolbar"><button disabled={!cursor} onClick={() => setCursor(undefined)}>第一页</button><button disabled={!listing.next} onClick={() => setCursor(listing.next)}>下一页</button></div></div>
    <div><label>记忆标题<input aria-label="记忆标题" value={draft.title} onChange={event => change({ title: event.target.value })} maxLength={200} /></label><div className="oss-toolbar"><label>类型<select value={draft.kind} onChange={event => change({ kind: event.target.value as MemoryDraft['kind'] })}><option value="fact">事实</option><option value="topic">主题</option><option value="summary">整合摘要</option></select></label><label>范围<select value={draft.scope} onChange={event => change({ scope: event.target.value as MemoryDraft['scope'] })}><option value="project">项目共享</option><option value="session">指定会话</option><option value="longterm">项目内长期记忆</option></select></label><label>上级主题<select value={draft.parentId || ''} onChange={event => change({ parentId: event.target.value || null })}><option value="">根目录</option>{listing.outline.topics.filter(topic => topic.id !== draft.id).map(topic => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label></div>
    {draft.scope === 'session' && <label>Harness 会话 ID<input aria-label="记忆会话 ID" value={draft.sessionId || ''} onChange={event => change({ sessionId: event.target.value })} /></label>}
    <label>记忆正文<textarea aria-label="记忆正文" value={draft.text} maxLength={20000} onChange={event => change({ text: event.target.value })} placeholder={draft.kind === 'summary' ? '核对来源后撰写摘要；建立摘要不会自动编造结论。' : '写明事实、适用条件和不确定性'} /></label>
    <details><summary>来源引用 JSON</summary><p>user / file / external 为声明来源，尚未独立核验；execution 固定本地执行回执；memory 固定来源记忆的版本和摘要。文件引用不会读取或上传文件。</p><textarea aria-label="记忆来源 JSON" className="oss-code" value={sources} onChange={event => { setSources(event.target.value); setDirty(true) }} /></details>
    <div className="oss-toolbar"><button disabled={busy || !draft.title.trim() || (!draft.text.trim() && draft.kind !== 'topic')} onClick={save}>保存记忆提案</button>{selected && <><button disabled={busy || dirty || selected.node.state === 'confirmed'} onClick={() => transition('confirm')}>确认此版本</button><button disabled={busy || dirty || selected.node.state === 'withdrawn'} onClick={() => transition('withdraw')}>撤回此版本</button></>}</div>
    {selected && <><p>当前 r{selected.node.revision} · {selected.node.state} · {selected.effective ? '进入有权读取的 Agent 上下文' : '未进入上下文'} {selected.issues.join('；')}</p><label><input type="checkbox" checked={promotion} onChange={event => setPromotion(event.target.checked)} />明确允许将引用的会话私有内容共享到所选范围</label>{draft.kind === 'summary' && <label><input type="checkbox" checked={consolidate} onChange={event => setConsolidate(event.target.checked)} />确认时用摘要替代来源条目参与上下文（保留原始历史）</label>}<details><summary>不可变版本历史</summary>{history.revisions.map(node => <div className="oss-variable" key={node.revision}><b>r{node.revision} · {node.state} · {node.title}</b><pre>{node.text}</pre><small>{node.updatedAt} · {node.approvedBy || '待确认'} · {node.digest}</small></div>)}{history.next && <button disabled={busy} onClick={() => void action(async () => { const page = await api<typeof history>(`${prefix}memory-history?id=${encodeURIComponent(selected.node.id)}&before=${history.next}`); setHistory(value => ({ revisions: [...value.revisions, ...page.revisions], next: page.next })) })}>更多历史</button>}</details></>}
    </div></div></article>
}
