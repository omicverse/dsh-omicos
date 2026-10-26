import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './storage.js'
import type { Execution } from './types.js'

export interface NotebookCell {
  id: string; kind: 'code' | 'markdown' | 'raw'; source: string
  metadata: Record<string, unknown>; attachments?: Record<string, unknown>; importedOutputs?: unknown[]
  runs: Array<{ operationId: string; executionId: string; sourceHash: string; at: string }>
}
export interface NotebookDocument {
  id: string; title: string; language: 'python' | 'r'; revision: number; updatedAt: string
  metadata: Record<string, unknown>; cells: NotebookCell[]
}
export class NotebookError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const sourceText = (source: unknown): string => {
  const text = Array.isArray(source) && source.every(item => typeof item === 'string') ? source.join('') : source
  if (typeof text !== 'string' || text.length > 200000) throw new NotebookError(400, 'Notebook 单元须为不超过 200000 字符的文本')
  return text
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) as Record<string, unknown> : {}
const bounded = (value: unknown) => { if (Buffer.byteLength(JSON.stringify(value)) > 2_000_000) throw new NotebookError(413, 'Notebook 超过 2 MB，请拆分后导入') }
/** Project-lock-owned documents. Source revisions are independent of immutable execution receipts. */
export class NotebookStore {
  private documents = new Map<string, NotebookDocument>()
  private writes: Promise<unknown> = Promise.resolve()
  private constructor(private path: string) {}
  static async open(workspace: string): Promise<NotebookStore> {
    const store = new NotebookStore(join(workspace, '.omicos-oss', 'notebooks.json'))
    const saved = await readJson<{ version: number; documents: NotebookDocument[] }>(store.path, { version: 1, documents: [] })
    if (saved.version !== 1 || !Array.isArray(saved.documents)) throw new Error('Unsupported Notebook store; preserve its contents and use a compatible runtime')
    for (const document of saved.documents) {
      if (!document || typeof document.id !== 'string' || !Number.isSafeInteger(document.revision) || !Array.isArray(document.cells) || !['python', 'r'].includes(document.language)) throw new Error('Invalid persisted Notebook identity')
      store.documents.set(document.id, document)
    }
    return store
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> { const pending = this.writes.then(action); this.writes = pending.catch(() => {}); return pending }
  private async commit(document: NotebookDocument): Promise<NotebookDocument> {
    bounded(document)
    const documents = [...this.documents.values()].filter(item => item.id !== document.id).concat(document)
    await writeJson(this.path, { version: 1, documents })
    this.documents.set(document.id, structuredClone(document))
    return structuredClone(document)
  }
  list() { return [...this.documents.values()].map(({ id, title, language, revision, updatedAt, cells }) => ({ id, title, language, revision, updatedAt, cells: cells.length })) }
  get(id: string): NotebookDocument { const document = this.documents.get(id); if (!document) throw new NotebookError(404, 'Notebook 不存在'); return structuredClone(document) }
  create(title: string, language: 'python' | 'r', imported?: unknown): Promise<NotebookDocument> {
    return this.mutate(async () => {
      if (this.documents.size >= 100) throw new NotebookError(409, '当前项目已有 100 个 Notebook，请另建项目')
      if (!['python', 'r'].includes(language)) throw new NotebookError(400, '请选择 Python 或 R 内核')
      let cells: NotebookCell[] = [{ id: randomUUID(), kind: 'code', source: '', metadata: {}, runs: [] }]; let metadata = {}
      if (imported !== undefined) {
        bounded(imported)
        const book = imported as any
        if (!book || book.nbformat !== 4 || !Array.isArray(book.cells) || book.cells.length > 500) throw new NotebookError(400, '仅支持 nbformat 4，最多 500 个单元')
        const specified = book.metadata?.kernelspec?.language ?? book.metadata?.language_info?.name
        if (specified && String(specified).toLowerCase() !== language) throw new NotebookError(400, 'Notebook 内核与所选语言不一致，请先选择正确语言')
        metadata = object(book.metadata)
        cells = book.cells.map((cell: any) => {
          if (!['code', 'markdown', 'raw'].includes(cell?.cell_type)) throw new NotebookError(400, '不支持的 Notebook 单元类型')
          return { id: randomUUID(), kind: cell.cell_type, source: sourceText(cell.source), metadata: object(cell.metadata), ...(cell.attachments ? { attachments: object(cell.attachments) } : {}), ...(cell.cell_type === 'code' && Array.isArray(cell.outputs) ? { importedOutputs: structuredClone(cell.outputs) } : {}), runs: [] }
        })
      }
      return this.commit({ id: randomUUID(), title: String(title || '未命名分析').slice(0, 200), language, revision: 1, updatedAt: new Date().toISOString(), metadata, cells })
    })
  }
  save(id: string, revision: number, title: string, cells: Array<Pick<NotebookCell, 'id' | 'kind' | 'source'>>): Promise<NotebookDocument> {
    return this.mutate(async () => {
      const document = this.get(id)
      if (document.revision !== revision) throw new NotebookError(409, 'Notebook 已在其他窗口更新，请重新加载后合并修改')
      if (!Array.isArray(cells) || cells.length > 500 || new Set(cells.map(cell => cell?.id)).size !== cells.length) throw new NotebookError(400, 'Notebook 单元列表无效或超过 500 项')
      const previous = new Map(document.cells.map(cell => [cell.id, cell]))
      document.cells = cells.map(cell => {
        if (typeof cell?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(cell.id) || !['code', 'markdown', 'raw'].includes(cell.kind)) throw new NotebookError(400, 'Notebook 单元标识或类型无效')
        const old = previous.get(cell.id)
        return { id: cell.id, kind: cell.kind, source: sourceText(cell.source), metadata: old?.metadata || {}, ...(old?.attachments ? { attachments: old.attachments } : {}), runs: old?.runs || [], ...(old?.source === cell.source && old.kind === cell.kind && old.importedOutputs ? { importedOutputs: old.importedOutputs } : {}) }
      })
      document.title = String(title || '未命名分析').slice(0, 200); document.revision++; document.updatedAt = new Date().toISOString()
      return this.commit(document)
    })
  }
  run(id: string, revision: number, cellId: string, operationId: string, submit: (language: 'python' | 'r', source: string, operationId: string, sessionId: string) => Promise<Execution>): Promise<{ document: NotebookDocument; execution: Execution }> {
    return this.mutate(async () => {
      const document = this.get(id); const cell = document.cells.find(item => item.id === cellId)
      if (!cell || cell.kind !== 'code' || !cell.source.trim()) throw new NotebookError(400, '请选择非空代码单元')
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) throw new NotebookError(400, '执行需要有效的稳定操作标识')
      const previous = document.cells.flatMap(item => item.runs.map(run => ({ cellId: item.id, ...run }))).find(run => run.operationId === operationId)
      if (previous && (previous.cellId !== cellId || previous.sourceHash !== hash(cell.source))) throw new NotebookError(409, '执行标识已用于其他代码，请核对历史结果')
      if (!previous && document.revision !== revision) throw new NotebookError(409, 'Notebook 已更新，请保存当前版本后再运行')
      if (!previous && cell.runs.length >= 1000) throw new NotebookError(409, '此单元已保留 1000 条执行引用，请新建单元继续分析')
      const execution = await submit(document.language, cell.source, operationId, `notebook:${document.id}:${cell.id}`)
      if (!previous) {
        cell.runs.push({ operationId, executionId: execution.id, sourceHash: hash(cell.source), at: execution.createdAt })
        document.revision++; document.updatedAt = new Date().toISOString()
        await this.commit(document)
      }
      return { document, execution }
    })
  }
  export(id: string, execution: (language: 'python' | 'r', id: string) => Execution | undefined): unknown {
    const document = this.get(id)
    return { nbformat: 4, nbformat_minor: 5, metadata: { ...document.metadata, kernelspec: { name: document.language === 'r' ? 'ir' : 'python3', display_name: document.language === 'r' ? 'R' : 'Python 3', language: document.language }, omicos: { notebookId: document.id, revision: document.revision } }, cells: document.cells.map(cell => {
      const latest = cell.runs.at(-1); const job = latest && latest.sourceHash === hash(cell.source) ? execution(document.language, latest.executionId) : undefined
      const metadata = { ...cell.metadata, omicos: { ...(job ? { invocation_id: job.id, state: job.state, kernel_generation: job.kernelGeneration, environment: job.environment, artifacts: job.artifacts } : {}), imported_outputs_unverified: Boolean(!job && cell.importedOutputs), runs: cell.runs } }
      return { id: cell.id, cell_type: cell.kind, source: cell.source, metadata, ...(cell.attachments && cell.kind !== 'code' ? { attachments: cell.attachments } : {}), ...(cell.kind === 'code' ? { execution_count: null, outputs: job ? [...(job.output ? [{ output_type: 'stream', name: 'stdout', text: job.output }] : []), ...(job.error ? [{ output_type: 'error', ename: job.state, evalue: job.error, traceback: job.error.split('\n') }] : [])] : cell.importedOutputs || [] } : {}) }
    }) }
  }
  async dispose(): Promise<void> { await this.writes }
}
