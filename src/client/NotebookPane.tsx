import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { NotebookCell, NotebookDocument } from '../oss/notebooks.js'
import type { Execution } from '../oss/types.js'

interface Summary { id: string; title: string; language: 'python' | 'r'; revision: number; cells: number }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function NotebookPane({ projectId, language, executions, onLanguage, refresh }: { projectId: string; language: 'python' | 'r'; executions: Execution[]; onLanguage: (language: 'python' | 'r') => void; refresh: () => Promise<void> }): JSX.Element {
  const [books, setBooks] = useState<Summary[]>([])
  const [document, setDocument] = useState<NotebookDocument>()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ cellId: string; source: string; operationId: string }>()
  const prefix = `project/${projectId}/`
  const reload = useCallback(async () => { const data = await api<{ notebooks: Summary[] }>(`${prefix}notebooks`); setBooks(data.notebooks) }, [prefix])
  useEffect(() => { void reload().catch(error => setError(message(error))) }, [reload])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('')
    try { await action() } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const mayDiscard = () => !dirty || window.confirm('当前 Notebook 有未保存修改，放弃这些修改？')
  const adopt = (next: NotebookDocument) => { setDocument(next); setDirty(false); onLanguage(next.language) }
  const open = (id: string) => void run(async () => { if (!mayDiscard()) return; adopt(await api<NotebookDocument>(`${prefix}notebook-document?id=${encodeURIComponent(id)}`)) })
  const create = (imported?: unknown, title?: string) => void run(async () => {
    if (!mayDiscard()) return
    adopt(await api<NotebookDocument>(`${prefix}notebook-create`, { title: title || '未命名分析', language, ...(imported === undefined ? {} : { imported }) }))
    await reload()
  })
  const save = async (): Promise<NotebookDocument> => {
    if (!document) throw new Error('请先打开 Notebook')
    if (!dirty) return document
    const next = await api<NotebookDocument>(`${prefix}notebook-save`, { id: document.id, revision: document.revision, title: document.title, cells: document.cells.map(({ id, kind, source }) => ({ id, kind, source })) })
    adopt(next); await reload(); return next
  }
  const changeCell = (id: string, change: Partial<Pick<NotebookCell, 'source' | 'kind'>>) => {
    if (!document) return
    setDocument({ ...document, cells: document.cells.map(cell => cell.id === id ? { ...cell, ...change } : cell) }); setDirty(true)
  }
  const execute = (cellId: string) => void run(async () => {
    const saved = await save(); const cell = saved.cells.find(cell => cell.id === cellId)!
    const operation = pending.current?.cellId === cellId && pending.current.source === cell.source ? pending.current : { cellId, source: cell.source, operationId: crypto.randomUUID() }
    pending.current = operation
    const result = await api<{ document: NotebookDocument; execution: Execution }>(`${prefix}notebook-run`, { id: saved.id, revision: saved.revision, cellId, operationId: operation.operationId, confirmed: true })
    pending.current = undefined; adopt(result.document); await reload(); await refresh()
  })
  const move = (index: number, offset: number) => {
    if (!document) return
    const cells = document.cells.slice(); const target = index + offset
    if (target < 0 || target >= cells.length) return
    ;[cells[index], cells[target]] = [cells[target], cells[index]]
    setDocument({ ...document, cells }); setDirty(true)
  }
  const importFile = async (file?: File) => {
    if (!file) return
    try { if (file.size > 2_000_000) throw new Error('Notebook 超过 2 MB，请拆分后导入'); const parsed = JSON.parse(await file.text()); create(parsed, file.name.replace(/\.ipynb$/i, '')) }
    catch (error) { setError(message(error)) }
  }
  return <article className="oss-card oss-notebook" aria-label="Notebook 编辑器"><div className="oss-row"><div><small>REPRODUCIBLE ANALYSIS</small><h2>Notebook</h2></div><span className="oss-chip">{document ? `${document.language === 'r' ? 'R' : 'Python'} · 修订 ${document.revision}${dirty ? ' · 未保存' : ''}` : '持久单元与执行引用'}</span></div>
    <p>导入仅载入文本和历史输出。批准运行后，单元才会在项目的共享内核执行；修改代码会使旧结果失效。执行顺序和内核状态由实际运行决定。</p>
    {error && <p role="alert" className="oss-error">{error}</p>}
    <div className="oss-toolbar"><label>项目 Notebook<select aria-label="项目 Notebook" value={document?.id || ''} disabled={busy} onChange={event => { if (event.target.value) open(event.target.value) }}><option value="">选择 Notebook</option>{books.map(book => <option key={book.id} value={book.id}>{book.title} · {book.language} · {book.cells} 单元</option>)}</select></label><button disabled={busy} onClick={() => create()}>新建 Notebook</button><label>导入 .ipynb<input aria-label="导入 Notebook" type="file" accept=".ipynb,application/json" disabled={busy} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = '' }} /></label></div>
    {document && <><label>Notebook 标题<input aria-label="Notebook 标题" value={document.title} maxLength={200} disabled={busy} onChange={event => { setDocument({ ...document, title: event.target.value }); setDirty(true) }} /></label><div className="oss-row"><div><button disabled={busy || !dirty} onClick={() => void run(async () => { await save() })}>保存 Notebook</button> <button disabled={busy} onClick={() => open(document.id)}>重新加载已保存版本</button></div>{!dirty && <a href={`/omicos/oss/api/${prefix}notebook-download?id=${encodeURIComponent(document.id)}`} download>下载 .ipynb ↗</a>}</div>
      {document.cells.map((cell, index) => {
        const last = cell.runs.at(-1); const job = last ? executions.find(job => job.id === last.executionId) : undefined
        const stale = Boolean(job && job.code !== cell.source)
        return <section className="oss-notebook-cell" aria-label={`Notebook 单元 ${index + 1}`} key={cell.id}><div className="oss-row"><label>单元 {index + 1}<select aria-label={`单元 ${index + 1} 类型`} value={cell.kind} disabled={busy} onChange={event => changeCell(cell.id, { kind: event.target.value as NotebookCell['kind'] })}><option value="code">代码</option><option value="markdown">Markdown</option><option value="raw">原始文本</option></select></label><div><button aria-label={`上移单元 ${index + 1}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button> <button aria-label={`下移单元 ${index + 1}`} disabled={busy || index === document.cells.length - 1} onClick={() => move(index, 1)}>↓</button> <button disabled={busy} onClick={() => { if (window.confirm('删除此单元？执行收据仍保留在项目历史中。')) { setDocument({ ...document, cells: document.cells.filter(item => item.id !== cell.id) }); setDirty(true) } }}>删除单元</button></div></div>
          <textarea className="oss-code" aria-label={`Notebook 单元 ${index + 1} 内容`} spellCheck={false} disabled={busy} value={cell.source} onChange={event => changeCell(cell.id, { source: event.target.value })} />
          {cell.kind === 'code' && <div className="oss-row"><button className="oss-primary" disabled={busy || !cell.source.trim()} onClick={() => execute(cell.id)}>保存并批准运行单元 {index + 1}</button><small>{last ? `${cell.runs.length} 次执行引用 · ${stale ? '代码已修改，历史输出已失效' : job?.state || '执行收据保留在项目历史'}` : cell.importedOutputs?.length ? '导入输出未经当前内核验证；重新执行后生成本地收据' : '尚未运行'}</small></div>}
          {job && !stale && cell.kind === 'code' && <div>{job.output && <pre className="oss-output">{job.output}</pre>}{job.error && <pre className="oss-error">{job.error}</pre>}<small>执行标识：<code>{job.id}</code></small></div>}
        </section>
      })}
      <button disabled={busy || document.cells.length >= 500} onClick={() => { setDocument({ ...document, cells: [...document.cells, { id: crypto.randomUUID(), kind: 'code', source: '', metadata: {}, runs: [] }] }); setDirty(true) }}>添加代码单元</button>
      <p><small>Markdown 与原始文本以可编辑文本展示；导入的富输出保留在导出文件中，浏览器不执行其中的 HTML 或 JavaScript。保存冲突时请重新加载并合并，避免覆盖其他窗口的修改。</small></p>
    </>}
  </article>
}
