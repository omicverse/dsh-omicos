import { FigureError } from './figure-types.js'
import { MemoryTree } from './memory-store.js'
import type { MemoryAccess } from './memory-types.js'
import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
// Load through Node so older Vite builtin lists do not rewrite node:sqlite to a package.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import { createHash } from 'node:crypto'
import { chmod, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson } from './storage.js'
import type { Execution, Memory } from './types.js'

export interface ScientificEvent { seq: number; type: string; language: string; executionId?: string; at: string; data: Record<string, unknown> }
const APPLICATION_ID = 0x4f4d4f53
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'])
/** Single-project, language-shared execution ledger. Scientific validity is not inferred. */
export class ScienceLedger {
  private closed = false
  readonly memory: MemoryTree
  private constructor(private db: Database) { this.memory = new MemoryTree(db, (type, data) => this.append(type, 'project', undefined, data), id => { const row = this.db.prepare('SELECT record_json FROM executions WHERE id=?').get(id); return row ? JSON.parse(String(row.record_json)) as Execution : undefined }) }
  static async open(workspace: string): Promise<ScienceLedger> {
    const directory = join(workspace, '.omicos-oss')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'project.sqlite')
    const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    const ledger = new ScienceLedger(db)
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
      const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 2 || (application !== 0 && application !== APPLICATION_ID) || (version >= 1 && application !== APPLICATION_ID)) throw new Error('Unsupported scientific ledger schema/application; preserve the database and use a compatible runtime')
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unknown database contents; refusing to adopt it as an OmicOS ledger')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE executions(id TEXT PRIMARY KEY, language TEXT NOT NULL, operation_id TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(language, operation_id));
          CREATE TABLE memories(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
          CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, language TEXT NOT NULL, execution_id TEXT, at TEXT NOT NULL, data_json TEXT NOT NULL);
          CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      }
      if (version < 2) await ledger.migrateLegacy(directory)
      ledger.memory.migrate()
      return ledger
    } catch (error) { db.close(); throw error }
  }
  private async migrateLegacy(directory: string): Promise<void> {
    if (this.db.prepare("SELECT value FROM metadata WHERE key='legacy-json-imported'").get()) return
    const sources = await Promise.all((['python', 'r'] as const).map(async language => {
      const base = language === 'r' ? join(directory, 'r') : directory
      return { language, jobs: await readJson<Execution[]>(join(base, 'executions.json'), []), memories: await readJson<Memory[]>(join(base, 'memories.json'), []) }
    }))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare("SELECT value FROM metadata WHERE key='legacy-json-imported'").get()) { this.db.exec('COMMIT'); return }
      for (const source of sources) {
        if (!Array.isArray(source.jobs) || !Array.isArray(source.memories)) throw new Error('Invalid legacy scientific metadata; originals were preserved')
        for (const job of source.jobs) this.upsertExecution(source.language, { ...job, language: source.language })
        for (const memory of source.memories) {
          if (!memory || typeof memory.id !== 'string' || typeof memory.text !== 'string' || typeof memory.source !== 'string') throw new Error('Invalid legacy project memory')
          const existing = this.db.prepare('SELECT record_json FROM memories WHERE id=?').get(memory.id)
          const id = existing && JSON.parse(String(existing.record_json)).text !== memory.text ? `${memory.id.slice(0, 150)}-${source.language}-${hash(memory.id + memory.text).slice(0, 10)}` : memory.id
          this.db.prepare('INSERT OR IGNORE INTO memories(id, record_json) VALUES(?,?)').run(id, JSON.stringify({ ...memory, id }))
        }
      }
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('legacy-json-imported', new Date().toISOString())
      this.append('storage/migrated', 'project', undefined, { source: 'atomic-json-v1', originals_preserved: true })
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  executions(language: string): Execution[] {
    return this.db.prepare('SELECT record_json FROM executions WHERE language=? ORDER BY rowid').all(language).map(row => JSON.parse(String(row.record_json)) as Execution)
  }
  execution(id: string): Execution | undefined { const row = this.db.prepare('SELECT record_json FROM executions WHERE id=?').get(id); return row ? JSON.parse(String(row.record_json)) as Execution : undefined }
  figureCandidates(cursor?: string) {
    const parts = cursor === undefined ? [Number.MAX_SAFE_INTEGER, -1] : cursor.split(':').map(Number)
    if (parts.length !== 2 || !Number.isSafeInteger(parts[0]) || parts[0] < 1 || !Number.isSafeInteger(parts[1]) || parts[1] < -1) throw new FigureError(400, 'Invalid artifact page cursor')
    const [row, index] = parts
    const rows = this.db.prepare(`SELECT e.rowid AS row_id,e.id,e.language,json_extract(e.record_json,'$.state') AS state,json_extract(e.record_json,'$.createdAt') AS created_at,a.key AS artifact_index,a.value AS artifact_json FROM executions e,json_each(e.record_json,'$.artifacts') a WHERE (e.rowid<? OR (e.rowid=? AND CAST(a.key AS INTEGER)>?)) ORDER BY e.rowid DESC,CAST(a.key AS INTEGER) LIMIT 51`).all(row, row, index)
    return { entries: rows.slice(0, 50).map(item => ({ source: { kind: 'project' as const, language: String(item.language) as 'python' | 'r', executionId: String(item.id), artifactId: JSON.parse(String(item.artifact_json)).id }, artifact: JSON.parse(String(item.artifact_json)), state: String(item.state), createdAt: String(item.created_at) })), next: rows.length > 50 ? `${rows[49].row_id}:${rows[49].artifact_index}` : undefined }
  }
  memories(sessionId?: string): Memory[] { return this.memory.active({ sessionId }).map(({ id, text, source, updatedAt }) => ({ id, text, source, updatedAt })) }
  saveExecutions(language: string, jobs: Execution[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const job of jobs) this.upsertExecution(language, job); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private upsertExecution(language: string, job: Execution): void {
    if (job.language !== language || !STATES.has(job.state) || typeof job.id !== 'string' || typeof job.operationId !== 'string' || typeof job.sessionId !== 'string' || typeof job.code !== 'string' || typeof job.output !== 'string' || !Array.isArray(job.artifacts)) throw new Error('Invalid scientific execution record')
    const serialized = JSON.stringify(job)
    const previous = this.db.prepare('SELECT record_json FROM executions WHERE id=?').get(job.id)
    if (previous?.record_json === serialized) return
    const old = previous ? JSON.parse(String(previous.record_json)) as Execution : undefined
    if (old && (old.code !== job.code || old.operationId !== job.operationId || old.sessionId !== job.sessionId || old.language !== language || old.expectedKernelGeneration !== job.expectedKernelGeneration)) throw new Error('Execution identity/code are immutable; create a new operation instead')
    this.db.prepare('INSERT INTO executions(id,language,operation_id,record_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(job.id, language, job.operationId, serialized)
    this.append(old?.state === job.state ? 'execution/output' : `execution/${job.state}`, language, job.id, {
      state: job.state, environment_sha256: job.environment?.fingerprint, operation_id: job.operationId, code_sha256: hash(job.code), output_sha256: hash(job.output), artifacts: job.artifacts,
      provenance_scope: 'execution receipt and artifact identity; input I/O coverage and scientific validity are not inferred',
    })
  }
  remember(id: string, text: string, source: string, access?: MemoryAccess): void { this.memory.legacy(id, text, source, access) }
  private append(type: string, language: string, executionId: string | undefined, data: unknown): void {
    this.db.prepare('INSERT INTO events(type,language,execution_id,at,data_json) VALUES(?,?,?,?,?)').run(type, language, executionId ?? null, new Date().toISOString(), JSON.stringify(data))
  }
  events(after = 0, limit = 200): ScientificEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid scientific event cursor/limit')
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => ({ seq: Number(row.seq), type: String(row.type), language: String(row.language), executionId: row.execution_id == null ? undefined : String(row.execution_id), at: String(row.at), data: JSON.parse(String(row.data_json)) }))
  }
  get cursor(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq) }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}
