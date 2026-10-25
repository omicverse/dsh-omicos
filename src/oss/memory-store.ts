import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync as Database } from 'node:sqlite'
import type { Execution, Memory } from './types.js'
import { MemoryError, type MemoryAccess, type MemoryDraft, type MemoryNode, type MemorySource, type MemoryView } from './memory-types.js'
const digest = (value: unknown): string => {
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, sorted(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
}
const hashNode = (node: MemoryNode) => { const { digest: _digest, ...body } = node; return digest(body) }
const bounded = (value: unknown, name: string, max: number, empty = false): string => { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new MemoryError(400, `Invalid ${name}`); return value }
const stamp = () => new Date().toISOString()
/** Shared project authority. Revisions are immutable; confirmation never proves scientific validity. */
export class MemoryTree {
  constructor(private db: Database, private event: (type: string, data: Record<string, unknown>) => void, private execution: (id: string) => Execution | undefined) {}
  migrate(): void {
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) >= 2) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(id,revision)); CREATE TABLE IF NOT EXISTS memory_operations(operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL);')
      for (const row of this.db.prepare('SELECT record_json FROM memories').all()) {
        const legacy = JSON.parse(String(row.record_json)) as Memory
        const node: MemoryNode = { ...legacy, schema: 2, title: legacy.text.split('\n')[0].slice(0, 100) || 'Imported fact', kind: 'fact', scope: 'project', parentId: null, state: 'confirmed', revision: 1, createdAt: legacy.updatedAt, sources: [{ kind: 'legacy', ref: legacy.source, verification: 'declared' }], approvedBy: 'legacy-import', approvedAt: legacy.updatedAt, digest: '' }
        node.digest = hashNode(node); this.write(node)
      }
      this.event('memory/tree-migrated', { schema: 2, originals_preserved: true, legacy_confirmation: 'retained without claiming new evidence validation' })
      this.db.exec('PRAGMA user_version=2; COMMIT;')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private raw(id: string, revision?: number): MemoryNode {
    bounded(id, 'memory id', 200)
    const row = revision === undefined ? this.db.prepare('SELECT record_json FROM memories WHERE id=?').get(id) : this.db.prepare('SELECT record_json FROM memory_revisions WHERE id=? AND revision=?').get(id, revision)
    if (!row) throw new MemoryError(404, 'Memory entry/revision not found')
    const node = JSON.parse(String(row.record_json)) as MemoryNode
    if (node.schema !== 2 || node.id !== id || !Number.isSafeInteger(node.revision) || node.revision < 1 || (revision !== undefined && node.revision !== revision) || node.digest !== hashNode(node)) throw new MemoryError(409, 'Memory revision identity was changed; preserve the database and inspect it')
    return node
  }
  private canRead(node: MemoryNode, access: MemoryAccess): boolean {
    if (access.owner) return true
    const visible = (entry: MemoryNode) => (entry.scope !== 'session' || entry.sessionId === access.sessionId) && (entry.state !== 'proposed' || !entry.originSessionId || entry.originSessionId === access.sessionId)
    if (!visible(node)) return false
    const seen = new Set([node.id]); let parent = node.parentId
    while (parent) { if (seen.has(parent) || seen.size > 24) return false; seen.add(parent); try { const entry = this.raw(parent); if (!visible(entry)) return false; parent = entry.parentId } catch { return false } }
    return true
  }
  get(id: string, access: MemoryAccess = {}, revision?: number): MemoryNode { const node = this.raw(id, revision); if (!this.canRead(node, access)) throw new MemoryError(404, 'Memory entry/revision not available to this session'); return node }
  private checkParent(node: Pick<MemoryNode, 'id' | 'parentId' | 'scope' | 'sessionId'>, access: MemoryAccess): void {
    const seen = new Set([node.id]); let parent = node.parentId; let depth = 0
    while (parent) {
      if (seen.has(parent) || ++depth > 24) throw new MemoryError(400, 'Memory topics must form an acyclic tree at most 24 levels deep')
      seen.add(parent); const entry = this.get(parent, access)
      if (entry.kind !== 'topic') throw new MemoryError(400, 'Only a topic may contain child entries')
      if (entry.scope === 'session' && (node.scope !== 'session' || node.sessionId !== entry.sessionId)) throw new MemoryError(400, 'Children cannot broaden a session topic’s visibility')
      parent = entry.parentId
    }
  }
  private issues(node: MemoryNode, visiting = new Set<string>(), memo = new Map<string, string[]>()): string[] {
    if (visiting.size > 64) return ['Memory dependency depth exceeds 64 revisions']
    if (memo.has(node.id)) return memo.get(node.id)!
    if (visiting.has(node.id)) return ['Cyclic memory dependency']
    const next = new Set(visiting).add(node.id); const issues: string[] = []
    if (!['confirmed', 'superseded'].includes(node.state)) issues.push(`Entry is ${node.state}`)
    if (node.parentId) { const parent = this.raw(node.parentId); if (this.issues(parent, next, memo).length) issues.push('Parent topic is not active/confirmed') }
    for (const source of node.sources.filter(source => source.kind === 'memory')) {
      try {
        const current = this.raw(source.ref)
        if (current.revision !== source.revision || current.digest !== source.digest) issues.push(`Source revision changed: ${source.ref}`)
        else if (this.issues(current, next, memo).length) issues.push(`Source is withdrawn, proposed or stale: ${source.ref}`)
      } catch { issues.push(`Source missing/unreadable: ${source.ref}`) }
    }
    memo.set(node.id, issues); return issues
  }
  view(id: string, access: MemoryAccess = {}): MemoryView { const node = this.get(id, access); const issues = this.issues(node); return { node, issues, effective: node.state === 'confirmed' && issues.length === 0 } }
  // Node 22.13 can finalize temporary prepared statements while a nested query runs
  // during iterate(). Materialize bounded pages before checking scope/dependencies.
  private *scan(before = Number.MAX_SAFE_INTEGER): Generator<{ rowid: number; id: string }> {
    for (;;) {
      const rows = this.db.prepare('SELECT rowid,id FROM memories WHERE rowid<? ORDER BY rowid DESC LIMIT 100').all(before)
      if (!rows.length) return
      for (const row of rows) yield { rowid: Number(row.rowid), id: String(row.id) }
      before = Number(rows.at(-1)!.rowid)
    }
  }
  list(access: MemoryAccess = {}, query: { search?: string; parentId?: string | null; before?: number; limit?: number } = {}) {
    const limit = query.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))) throw new MemoryError(400, 'Invalid memory page cursor/limit')
    const search = (query.search || '').toLocaleLowerCase().slice(0, 500)
    const rows = this.scan(query.before)
    const entries: MemoryView[] = []; let next: number | undefined; let lastRowId: number | undefined
    for (const row of rows) {
      const node = this.raw(String(row.id))
      if (!this.canRead(node, access) || (query.parentId !== undefined && node.parentId !== query.parentId) || (search && !`${node.title}\n${node.text}\n${node.source}`.toLocaleLowerCase().includes(search))) continue
      if (entries.length === limit) { next = lastRowId; break }
      entries.push(this.view(node.id, access)); lastRowId = Number(row.rowid)
    }
    return { entries, ...(next === undefined ? {} : { next }) }
  }
  outline(access: MemoryAccess = {}) {
    const topics: Array<Pick<MemoryNode, 'id' | 'title' | 'parentId' | 'scope' | 'sessionId' | 'state' | 'revision'>> = []
    for (const row of this.scan()) {
      const node = this.raw(String(row.id)); if (node.kind !== 'topic' || !this.canRead(node, access)) continue
      if (topics.length >= 500) return { topics, truncated: true }
      const { id, title, parentId, scope, sessionId, state, revision } = node; topics.push({ id, title, parentId, scope, sessionId, state, revision })
    }
    return { topics, truncated: false }
  }
  summaryList(access: MemoryAccess = {}, query: Parameters<MemoryTree['list']>[1] = {}) {
    const result = this.list(access, query)
    return { entries: result.entries.map(({ node, effective, issues }) => { const { id, title, kind, scope, sessionId, parentId, state, revision, updatedAt, digest } = node; return { id, title, kind, scope, sessionId, parentId, state, revision, updatedAt, digest, preview: node.text.slice(0, 500), sourceCount: node.sources.length, effective, issues } }), next: result.next, outline: this.outline(access) }
  }
  private sources(input: MemoryDraft['sources'], access: MemoryAccess, ownId: string): MemorySource[] {
    if (!Array.isArray(input) || input.length > 30) throw new MemoryError(400, 'Memory needs at most 30 explicit sources')
    if (new Set(input.map(source => `${source?.kind}:${source?.ref}`)).size !== input.length) throw new MemoryError(400, 'Source references must be unique')
    return input.map(source => {
      if (!['user', 'legacy', 'external', 'file', 'execution', 'memory'].includes(source?.kind)) throw new MemoryError(400, 'Unsupported memory source kind')
      const ref = bounded(source.ref, 'source reference', 2000); const note = source.note === undefined ? undefined : bounded(source.note, 'source note', 2000, true)
      if (source.kind === 'memory') {
        if (ref === ownId) throw new MemoryError(400, 'An entry cannot cite itself')
        const referenced = this.get(ref, access)
        if (source.revision !== undefined && source.revision !== referenced.revision) throw new MemoryError(409, 'Memory source changed; reload before proposing a summary')
        if (source.digest !== undefined && source.digest !== referenced.digest) throw new MemoryError(409, 'Memory source digest changed')
        return { kind: 'memory', ref, note, revision: referenced.revision, digest: referenced.digest, scope: referenced.scope, sessionId: referenced.sessionId, verification: 'pinned-memory' }
      }
      if (source.kind === 'execution') {
        const execution = this.execution(ref)
        if (!execution || ['queued', 'running'].includes(execution.state)) throw new MemoryError(400, 'Use a completed local project execution receipt as evidence')
        return { kind: 'execution', ref, note, digest: digest({ id: execution.id, code: execution.code, output: execution.output, state: execution.state, artifacts: execution.artifacts }), verification: 'local-receipt' }
      }
      if (source.kind === 'file' && (ref.startsWith('/') || ref.includes('\\') || /^[a-zA-Z]:/.test(ref) || ref.split('/').some(part => !part || part === '..' || part.startsWith('.')))) throw new MemoryError(400, 'Declared files use project-relative, non-private paths')
      if (source.digest !== undefined && !/^[a-f0-9]{64}$/.test(source.digest)) throw new MemoryError(400, 'Source digest must be SHA-256')
      return { kind: source.kind, ref, note, digest: source.digest, verification: 'declared' }
    })
  }
  private write(node: MemoryNode): MemoryNode {
    node.digest = hashNode(node)
    const record = JSON.stringify(node)
    this.db.prepare('INSERT INTO memory_revisions(id,revision,record_json) VALUES(?,?,?)').run(node.id, node.revision, record)
    this.db.prepare('INSERT INTO memories(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(node.id, record)
    return node
  }
  private mutate(operationId: string, request: unknown, access: MemoryAccess, action: () => MemoryNode): MemoryNode {
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(operationId)) throw new MemoryError(400, 'A stable memory operation id is required')
    const requestHash = digest(request)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT request_hash,result_json FROM memory_operations WHERE operation_id=?').get(operationId)
      if (existing) { if (existing.request_hash !== requestHash) throw new MemoryError(409, 'Memory operation belongs to another request'); const previous = JSON.parse(String(existing.result_json)) as MemoryNode; const current = this.get(previous.id, access); this.db.exec('COMMIT'); return current }
      const result = action(); this.db.prepare('INSERT INTO memory_operations(operation_id,request_hash,result_json) VALUES(?,?,?)').run(operationId, requestHash, JSON.stringify(result)); this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  propose(input: MemoryDraft, access: MemoryAccess = {}): MemoryNode {
    if (!input || typeof input !== 'object') throw new MemoryError(400, 'A memory proposal is required')
    return this.mutate(input.operationId, { action: 'propose', input, session: access.sessionId || null, owner: Boolean(access.owner) }, access, () => {
      const old = input.id ? this.get(input.id, access) : undefined
      if (old && old.revision !== input.revision) throw new MemoryError(409, 'Memory changed; reload before revising it')
      if (!['topic', 'fact', 'summary'].includes(input.kind) || !['project', 'session', 'longterm'].includes(input.scope)) throw new MemoryError(400, 'Invalid memory kind/scope')
      const sessionId = input.scope === 'session' ? bounded(input.sessionId || access.sessionId, 'session id', 200) : undefined
      if (!access.owner && sessionId && sessionId !== access.sessionId) throw new MemoryError(403, 'Cannot write another session’s notes')
      const at = stamp(); const id = old?.id || randomUUID(); const sources = this.sources(input.sources, access, id)
      const node: MemoryNode = { id, schema: 2, revision: (old?.revision || 0) + 1, title: bounded(input.title, 'memory title', 200), text: bounded(input.text, 'memory text', 20000, input.kind === 'topic'), source: sources.map(source => `${source.kind}:${source.ref}`).join('; ').slice(0, 4000), kind: input.kind, scope: input.scope, sessionId, originSessionId: old?.originSessionId || access.sessionId, parentId: input.parentId || null, state: 'proposed', createdAt: old?.createdAt || at, updatedAt: at, sources, digest: '' }
      if (old?.promotionRequired || (old?.scope === 'session' && (node.scope !== 'session' || node.sessionId !== old.sessionId))) node.promotionRequired = true
      if (node.kind !== 'topic' && !node.sources.length) throw new MemoryError(400, 'Facts/summaries need an explicit source')
      this.checkParent(node, access)
      if (old?.kind === 'topic') { const children = this.db.prepare("SELECT record_json FROM memories WHERE json_extract(record_json,'$.parentId')=?").all(old.id).map(row => JSON.parse(String(row.record_json)) as MemoryNode); if (children.length && node.kind !== 'topic') throw new MemoryError(400, 'Move child entries before changing a topic into a fact'); if (node.scope === 'session' && children.some(child => child.scope !== 'session' || child.sessionId !== node.sessionId)) throw new MemoryError(400, 'A topic cannot narrow visibility before its children are moved/re-scoped') }
      this.write(node); this.event('memory/proposed', { id, revision: node.revision, digest: node.digest, actor: access.actor, scope: node.scope }); return node
    })
  }
  transition(input: { id: string; revision: number; action: 'confirm' | 'withdraw' | 'move'; operationId: string; parentId?: string | null; reason?: string; supersedeSources?: boolean; allowScopePromotion?: boolean }, access: MemoryAccess = {}): MemoryNode {
    if (!input || typeof input !== 'object') throw new MemoryError(400, 'A memory transition is required')
    return this.mutate(input.operationId, { action: 'transition', input, session: access.sessionId || null, owner: Boolean(access.owner) }, access, () => {
      const old = this.get(input.id, access)
      if (old.revision !== input.revision) throw new MemoryError(409, 'Memory changed; review its current revision first')
      const at = stamp(); const node: MemoryNode = { ...old, revision: old.revision + 1, updatedAt: at, changeReason: input.reason ? bounded(input.reason, 'change reason', 2000) : undefined }
      if (input.action === 'withdraw') node.state = 'withdrawn'
      else if (input.action === 'move') { node.parentId = input.parentId || null; this.checkParent(node, access) }
      else if (input.action === 'confirm') {
        this.checkParent(node, access)
        if (node.promotionRequired && input.allowScopePromotion !== true) throw new MemoryError(400, 'Explicitly approve sharing session-source content before promotion')
        if (node.parentId && this.issues(this.raw(node.parentId)).length) throw new MemoryError(409, 'Confirm/reinstate the parent topic before confirming its children')
        const sources = node.sources.filter(source => source.kind === 'memory')
        for (const source of sources) {
          const current = this.raw(source.ref)
          if (current.revision !== source.revision || current.digest !== source.digest || this.issues(current).length) throw new MemoryError(409, 'A source is changed, unconfirmed or withdrawn; revise the proposal first')
          if (current.scope === 'session' && (node.scope !== 'session' || node.sessionId !== current.sessionId) && input.allowScopePromotion !== true) throw new MemoryError(400, 'Explicitly approve sharing session-source content before promotion')
        }
        if (input.supersedeSources) {
          if (node.kind !== 'summary' || !sources.length) throw new MemoryError(400, 'Only a sourced summary can consolidate original entries')
          for (const source of sources) {
            const current = this.raw(source.ref)
            if (current.kind === 'topic' || current.state !== 'confirmed' || !this.canRead(current, access)) throw new MemoryError(403, 'Cannot supersede this source entry')
            const superseded = this.write({ ...current, revision: current.revision + 1, state: 'superseded', updatedAt: at, changeReason: `Consolidated into ${node.id}` })
            source.revision = superseded.revision; source.digest = superseded.digest
            this.event('memory/superseded', { id: superseded.id, revision: superseded.revision, by: node.id, actor: access.actor })
          }
        }
        node.state = 'confirmed'; node.promotionRequired = false
        if (this.issues(node).length) throw new MemoryError(409, 'Consolidation changes a dependent source; consolidate independent entries or revise the source graph first')
        node.approvedAt = at; node.approvedBy = access.actor || 'explicit-caller'; node.scopePromotionApproved = input.allowScopePromotion === true
      } else throw new MemoryError(400, 'Invalid memory action')
      this.write(node); this.event(`memory/${input.action === 'confirm' ? 'confirmed' : input.action === 'withdraw' ? 'withdrawn' : 'moved'}`, { id: node.id, revision: node.revision, digest: node.digest, actor: access.actor, sourceCount: node.sources.length }); return node
    })
  }
  history(id: string, access: MemoryAccess = {}, before?: number): { revisions: MemoryNode[]; next?: number } {
    this.get(id, access)
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new MemoryError(400, 'Invalid memory revision cursor')
    const rows = this.db.prepare('SELECT revision FROM memory_revisions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51').all(id, before ?? Number.MAX_SAFE_INTEGER)
    const revisions = rows.slice(0, 50).map(row => this.raw(id, Number(row.revision))).filter(node => this.canRead(node, access))
    return { revisions, ...(rows.length > 50 ? { next: Number(rows[49].revision) } : {}) }
  }
  active(access: MemoryAccess = {}): MemoryNode[] {
    const memo = new Map<string, string[]>()
    return this.db.prepare('SELECT id FROM memories ORDER BY rowid').all().map(row => this.raw(String(row.id))).filter(node => node.kind !== 'topic' && this.canRead(node, access) && node.state === 'confirmed' && !this.issues(node, new Set(), memo).length)
  }
  context(access: MemoryAccess = {}, budget = 16000) {
    const active = this.active(access).sort((a, b) => Number(b.scope === 'session') - Number(a.scope === 'session') || b.updatedAt.localeCompare(a.updatedAt))
    const entries: Array<Pick<MemoryNode, 'id' | 'revision' | 'title' | 'text' | 'scope' | 'digest' | 'sources'>> = []; let used = 0
    for (const node of active) { const entry = { id: node.id, revision: node.revision, title: node.title, text: node.text, scope: node.scope, digest: node.digest, sources: node.sources }; const bytes = JSON.stringify(entry).length; if (used + bytes <= budget) { entries.push(entry); used += bytes } }
    return { schema: 2, entries, omitted: active.length - entries.length, snapshotPolicy: 'Current entries supersede earlier memory snapshots. If an earlier entry is absent, inspect the memory tree before relying on it; omission can reflect withdrawal, changed evidence or the context budget.' }
  }
  legacy(id: string, text: string, source: string, access: MemoryAccess = { owner: true, actor: 'legacy-caller' }): void {
    bounded(id, 'memory id', 200); bounded(source, 'memory source', 2000); bounded(text, 'memory text', 20000, true)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let old: MemoryNode | undefined
      try { old = this.get(id, access) } catch (error) { if (!(error instanceof MemoryError) || error.status !== 404 || this.db.prepare('SELECT id FROM memories WHERE id=?').get(id)) throw error }
      if (!text && !old) { this.event('memory/deleted', { id, source, retained_history: true }); this.db.exec('COMMIT'); return }
      const at = stamp(); const node: MemoryNode = old ? { ...old, revision: old.revision + 1, updatedAt: at, ...(text ? { text, title: text.split('\n')[0].slice(0, 100), source, state: 'confirmed' as const, sources: [{ kind: 'legacy' as const, ref: source, verification: 'declared' as const }] } : { state: 'withdrawn' as const, changeReason: source }) } : { id, schema: 2, title: text.split('\n')[0].slice(0, 100), kind: 'fact', text, source, state: 'confirmed', revision: 1, scope: 'project', parentId: null, createdAt: at, updatedAt: at, sources: [{ kind: 'legacy', ref: source, verification: 'declared' }], digest: '' }
      if (text) { node.approvedAt = at; node.approvedBy = access.actor || 'legacy-caller' }
      this.write(node); this.event(text ? 'memory/saved' : 'memory/deleted', { id, source, revision: node.revision, text_sha256: createHash('sha256').update(text).digest('hex'), retained_history: true }); this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
