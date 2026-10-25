import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, open } from 'node:fs/promises'
import { join } from 'node:path'
import { FigureError, type FigureDraft, type FigureSource, type FigureVersion, type ResolvedFigure } from './figure-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const canonical = (value: any): string => JSON.stringify(sort(value))
function sort(value: any): any { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, sort(value[key])])) : value }
const fingerprint = (node: FigureVersion) => { const { digest: _, ...body } = node; return hash(canonical(body)) }
const text = (value: unknown, name: string, max: number, empty = false) => { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new FigureError(400, `Invalid ${name}`); return value }
const references = (value: unknown, name: string): string[] => { if (!Array.isArray(value) || value.length > 100) throw new FigureError(400, `Use at most 100 ${name}`); return value.map(item => text(item, name, 2000)) }
export function figureSource(input: FigureSource): FigureSource {
  if (!input || !['project', 'pipeline'].includes(input.kind) || !['python', 'r'].includes(input.language)) throw new FigureError(400, 'Choose a project/Pipeline execution artifact')
  return { kind: input.kind, language: input.language, executionId: text(input.executionId, 'execution id', 200), artifactId: text(input.artifactId, 'artifact id', 200), ...(input.kind === 'pipeline' ? { runId: text(input.runId, 'Pipeline run id', 200) } : {}) }
}
/** Curated figure metadata points at immutable execution bytes; no image mutation or hidden code execution. */
export class FigureStudio {
  private writes: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposing?: Promise<void>
  private constructor(private db: Database, private resolve: (source: FigureSource) => Promise<ResolvedFigure>) {}
  static async open(workspace: string, resolve: (source: FigureSource) => Promise<ResolvedFigure>): Promise<FigureStudio> {
    const path = join(workspace, '.omicos-oss', 'figures.sqlite'); const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 1 || (version && application !== 0x4f464947) || (!version && application && application !== 0x4f464947)) throw new Error('Unsupported Figure Studio database; preserve it and use a compatible runtime')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (!version) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Refusing to adopt unknown Figure Studio database contents')
        db.exec(`BEGIN IMMEDIATE; CREATE TABLE figures(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,revision)); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,figure_id TEXT NOT NULL); PRAGMA application_id=${0x4f464947}; PRAGMA user_version=1; COMMIT;`)
      }
      return new FigureStudio(db, resolve)
    } catch (error) { db.close(); throw error }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> { if (this.closing) return Promise.reject(new FigureError(409, 'Figure Studio is closing')); const task = this.writes.then(action); this.writes = task.catch(() => {}); return task }
  get(id: string, revision?: number): FigureVersion {
    text(id, 'figure id', 200)
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new FigureError(400, 'Invalid figure revision')
    const row = revision === undefined ? this.db.prepare('SELECT record_json FROM figures WHERE id=?').get(id) : this.db.prepare('SELECT record_json FROM revisions WHERE id=? AND revision=?').get(id, revision)
    if (!row) throw new FigureError(404, 'Figure/revision not found')
    const node = JSON.parse(String(row.record_json)) as FigureVersion
    if (node.id !== id || (revision !== undefined && node.revision !== revision) || fingerprint(node) !== node.digest) throw new FigureError(409, 'Figure revision identity changed; preserve and inspect the database')
    return node
  }
  list(query = '', before = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(before) || before < 1) throw new FigureError(400, 'Invalid Figure Studio page cursor')
    const entries: Array<Pick<FigureVersion, 'id' | 'revision' | 'title' | 'caption' | 'source' | 'artifact' | 'review' | 'updatedAt'>> = []; let next: number | undefined; let last: number | undefined
    const search = query.slice(0, 500)
    const rows = this.db.prepare(`SELECT rowid,id FROM figures WHERE rowid<? AND (?='' OR instr(lower(json_extract(record_json,'$.title') || char(10) || json_extract(record_json,'$.caption')),lower(?))>0) ORDER BY rowid DESC LIMIT 51`).all(before, search, search)
    for (const row of rows) {
      const node = this.get(String(row.id))
      if (entries.length === 50) { next = last; break }
      const { id, revision, title, caption, source, artifact, review, updatedAt } = node; entries.push({ id, revision, title, caption, source, artifact, review, updatedAt }); last = Number(row.rowid)
    }
    return { entries, next }
  }
  history(id: string, before = Number.MAX_SAFE_INTEGER) {
    this.get(id); if (!Number.isSafeInteger(before) || before < 1) throw new FigureError(400, 'Invalid figure revision cursor')
    const rows = this.db.prepare('SELECT revision FROM revisions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51').all(id, before)
    return { revisions: rows.slice(0, 50).map(row => this.get(id, Number(row.revision))), next: rows.length > 50 ? Number(rows[49].revision) : undefined }
  }
  private replay(operation: string, request: unknown): FigureVersion | undefined {
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(operation)) throw new FigureError(400, 'A stable figure operation id is required')
    const row = this.db.prepare('SELECT request_hash,figure_id FROM operations WHERE id=?').get(operation)
    if (!row) return
    if (row.request_hash !== hash(canonical(request))) throw new FigureError(409, 'Figure operation belongs to another request')
    return this.get(String(row.figure_id))
  }
  private commit(node: FigureVersion, operation: string, request: unknown): FigureVersion {
    node.digest = fingerprint(node); const record = JSON.stringify(node)
    this.db.exec('BEGIN IMMEDIATE')
    try { this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(node.id, node.revision, record); this.db.prepare('INSERT INTO figures VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(node.id, record); this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operation, hash(canonical(request)), node.id); this.db.exec('COMMIT'); return node } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  save(input: FigureDraft, actor: string): Promise<FigureVersion> {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object') throw new FigureError(400, 'A figure proposal is required')
      const request = { action: 'save', input, actor }; const replay = this.replay(input.operationId, request); if (replay) return replay
      const old = input.id ? this.get(input.id) : undefined
      if (old && input.revision !== old.revision) throw new FigureError(409, 'Figure changed; reload before saving')
      const source = figureSource(input.source); const title = text(input.title, 'figure title', 200); const caption = text(input.caption, 'figure caption', 20000, true); const methods = references(input.methods, 'method references'); const dataReferences = references(input.dataReferences, 'declared data references')
      const result = await this.resolve(source); const execution = result.execution
      if (!['succeeded', 'failed', 'canceled', 'interrupted'].includes(execution.state)) throw new FigureError(409, 'Wait for a terminal execution receipt before curating its figure')
      if (!['image/png', 'application/pdf', 'image/svg+xml', 'image/jpeg'].includes(result.artifact.mime)) throw new FigureError(400, 'Only PNG, JPEG, PDF or SVG figure artifacts are supported')
      if (hash(result.bytes) !== result.artifact.sha256 || result.bytes.length !== result.artifact.bytes) throw new FigureError(409, 'Figure bytes changed since execution')
      const at = new Date().toISOString()
      return this.commit({ id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, title, caption, source, methods, dataReferences, artifact: result.artifact, createdAt: old?.createdAt || at, updatedAt: at, author: actor, digest: '', review: { state: 'draft' }, execution: { id: execution.id, state: execution.state, code: execution.code, codeSha256: hash(execution.code), outputSha256: hash(execution.output), environment: execution.environment } }, input.operationId, request)
    })
  }
  review(input: { id: string; revision: number; decision: 'approved' | 'changes-requested' | 'withdrawn'; note: string; operationId: string }, actor: string): Promise<FigureVersion> {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object') throw new FigureError(400, 'A figure review is required')
      const request = { action: 'review', input, actor }; const replay = this.replay(input.operationId, request); if (replay) return replay
      const old = this.get(input.id); if (old.revision !== input.revision) throw new FigureError(409, 'Figure changed; inspect its current revision before review')
      if (!['approved', 'changes-requested', 'withdrawn'].includes(input.decision)) throw new FigureError(400, 'Invalid figure review decision')
      const note = text(input.note, 'review note', 10000)
      if (input.decision === 'approved') { const resolved = await this.resolve(old.source); if (hash(resolved.bytes) !== old.artifact.sha256 || resolved.bytes.length !== old.artifact.bytes) throw new FigureError(409, 'Cannot approve a figure whose source bytes changed') }
      const at = new Date().toISOString()
      return this.commit({ ...old, revision: old.revision + 1, updatedAt: at, review: { state: input.decision, actor, note, at, assessedDigest: old.digest } }, input.operationId, request)
    })
  }
  async artifact(id: string, revision?: number): Promise<{ bytes: Buffer; mime: string }> {
    const node = this.get(id, revision); const source = await this.resolve(node.source)
    if (hash(source.bytes) !== node.artifact.sha256 || source.bytes.length !== node.artifact.bytes) throw new FigureError(409, 'Figure artifact no longer matches the saved revision')
    return { bytes: source.bytes, mime: node.artifact.mime }
  }
  async integrity(id: string, revision?: number) {
    const node = this.get(id, revision); const checkedAt = new Date().toISOString()
    try { await this.artifact(id, node.revision); return { state: 'verified' as const, revision: node.revision, sha256: node.artifact.sha256, checkedAt } }
    catch (error) { return { state: error instanceof FigureError && error.status === 409 ? 'changed' as const : 'unavailable' as const, revision: node.revision, sha256: node.artifact.sha256, checkedAt, reason: error instanceof Error ? error.message : String(error) } }
  }
  manifest(id: string, revision?: number) { return { schema: 'omicos.figure/1', figure: this.get(id, revision), provenanceScope: 'Execution and artifact identity; declared method/data references are not independently validated. Review records an explicit human assessment, not automatic scientific validation. Source bytes are verified again when downloaded.', exportedAt: new Date().toISOString() } }
  dispose(): Promise<void> { return this.disposing ??= this.shutdown() }
  private async shutdown(): Promise<void> { this.closing = true; await this.writes; this.db.close() }
}
