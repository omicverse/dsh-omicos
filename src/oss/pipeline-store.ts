import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { PipelineError, type PipelineDefinition, type PipelineRun, type PipelineEvent } from './pipeline-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const APPLICATION = 0x4f50534c
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const text = (value: unknown, name: string, max: number, empty = false): string => { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new PipelineError(400, `Invalid ${name}`); return value }
const paths = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new PipelineError(400, 'Declare at most 100 files per stage')
  return [...new Set(value.map(path => { const name = text(path, 'project-relative file path', 2000); if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.omicos-oss'))) throw new PipelineError(400, 'Use explicit project-relative data file paths'); return name }))]
}
export function normalizePipeline(input: any): PipelineDefinition {
  if (!input || typeof input !== 'object' || Buffer.byteLength(JSON.stringify(input)) > 2_000_000) throw new PipelineError(400, 'Pipeline definition must be a JSON object below 2 MB')
  if (input.executorVersion !== undefined && input.executorVersion !== 1) throw new PipelineError(400, 'Unsupported Pipeline executor version')
  if (!['python', 'r'].includes(input.language) || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 100) throw new PipelineError(400, 'Choose Python or R and 1–100 ordered steps')
  const parameters = input.parameters ?? {}
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Buffer.byteLength(JSON.stringify(parameters)) > 100000) throw new PipelineError(400, 'Parameters must be a JSON object below 100 KB')
  const references = input.references ?? []
  if (!Array.isArray(references) || references.length > 50) throw new PipelineError(400, 'At most 50 embedded versioned references')
  const definition: Omit<PipelineDefinition, 'id'> = { executorVersion: 1, title: text(input.title, 'Pipeline title', 200), language: input.language as 'python' | 'r', parameters: JSON.parse(JSON.stringify(parameters)), references: references.map((reference: any) => {
    const source = text(reference?.text, 'reference text', 50000)
    if (reference.sha256 !== undefined && reference.sha256 !== digest(source)) throw new PipelineError(400, 'Reference content hash does not match its pinned text')
    return { id: text(reference.id, 'reference id', 200), version: text(reference.version, 'reference version', 200), text: source, sha256: digest(source) }
  }), inputs: paths(input.inputs), steps: input.steps.map((step: any) => {
    const id = text(step?.id, 'step id', 80)
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new PipelineError(400, 'Step ids use letters, digits, underscore or hyphen')
    const checkpoint = step.checkpoint ? { files: paths(step.checkpoint.files), restoreCode: text(step.checkpoint.restoreCode, 'checkpoint restore code', 200000) } : undefined
    if (checkpoint && checkpoint.files.length === 0) throw new PipelineError(400, 'A checkpoint needs at least one durable data file')
    return { id, title: text(step.title || id, 'step title', 200), code: text(step.code, 'step code', 200000), gate: step.gate === true, outputs: paths(step.outputs), ...(checkpoint ? { checkpoint } : {}) }
  }) }
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length) throw new PipelineError(400, 'Step ids must be unique')
  if (definition.steps.some(step => [...step.outputs, ...step.checkpoint?.files || []].some(path => definition.inputs.includes(path)))) throw new PipelineError(400, 'Raw inputs cannot also be declared mutable outputs/checkpoints')
  // Normalize JSON object keys so equivalent bindings pin one definition regardless of editor key order.
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const normalized = canonical(definition)
  const pinned = { id: digest(JSON.stringify(normalized)), ...normalized }
  if (Buffer.byteLength(JSON.stringify(pinned)) > 2_000_000) throw new PipelineError(413, 'Normalized Pipeline definition exceeds 2 MB')
  return pinned
}
export class PipelineStore {
  private constructor(private db: Database) {}
  static async open(workspace: string): Promise<PipelineStore> {
    const directory = join(workspace, '.omicos-oss'); await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'pipelines.sqlite'); const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=5000;')
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 1 || (application !== 0 && application !== APPLICATION) || (version === 1 && application !== APPLICATION)) throw new Error('Unsupported Pipeline database; preserve it and use a compatible runtime')
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unrecognized Pipeline database contents')
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (version === 0) db.exec(`BEGIN IMMEDIATE; CREATE TABLE definitions(id TEXT PRIMARY KEY, document_json TEXT NOT NULL); CREATE TABLE runs(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data_json TEXT NOT NULL); PRAGMA application_id=${APPLICATION}; PRAGMA user_version=1; COMMIT;`)
      return new PipelineStore(db)
    } catch (error) { db.close(); throw error }
  }
  define(input: unknown): PipelineDefinition { const definition = normalizePipeline(input); this.db.prepare('INSERT OR IGNORE INTO definitions(id,document_json) VALUES(?,?)').run(definition.id, JSON.stringify(definition)); return definition }
  definition(id: string): PipelineDefinition { const row = this.db.prepare('SELECT document_json FROM definitions WHERE id=?').get(id); if (!row) throw new PipelineError(404, 'Pipeline definition not found'); const saved = JSON.parse(String(row.document_json)); if (normalizePipeline(saved).id !== id) throw new PipelineError(409, 'Pinned Pipeline definition was modified; preserve the database and inspect it'); return saved }
  definitions() { return this.db.prepare('SELECT document_json FROM definitions ORDER BY rowid DESC').all().map(row => { const { id, title, language, steps } = JSON.parse(String(row.document_json)) as PipelineDefinition; return { id, title, language, steps: steps.length } }) }
  runs(): PipelineRun[] { return this.db.prepare('SELECT record_json FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => JSON.parse(String(row.record_json))) }
  recover(): void { for (const row of this.db.prepare('SELECT record_json FROM runs').all()) { const run: PipelineRun = JSON.parse(String(row.record_json)); if (['preparing', 'running', 'cancelling', 'waiting'].includes(run.state)) this.update(run.id, undefined, 'run/interrupted', draft => { draft.state = 'interrupted'; draft.reason = 'Host stopped. Inspect partial side effects; recovery requires explicit approval.' }) } }
  get(id: string): PipelineRun { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new PipelineError(400, 'Invalid Pipeline run id'); const row = this.db.prepare('SELECT record_json FROM runs WHERE id=?').get(id); if (!row) throw new PipelineError(404, 'Pipeline run not found'); const run = JSON.parse(String(row.record_json)) as PipelineRun; if (run.id !== id || !Number.isSafeInteger(run.revision) || run.revision < 1 || !/^[a-f0-9]{64}$/.test(run.definitionId)) throw new PipelineError(409, 'Invalid persisted Pipeline identity'); return run }
  byOperation(operationId: string): PipelineRun | undefined { const row = this.db.prepare('SELECT record_json FROM runs WHERE operation_id=?').get(operationId); return row ? JSON.parse(String(row.record_json)) : undefined }
  create(definitionId: string, operationId: string): { run: PipelineRun; created: boolean } {
    this.definition(definitionId)
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) throw new PipelineError(400, 'A stable start operation id is required')
    const existing = this.db.prepare('SELECT record_json FROM runs WHERE operation_id=?').get(operationId)
    if (existing) { const run = JSON.parse(String(existing.record_json)) as PipelineRun; if (run.definitionId !== definitionId) throw new PipelineError(409, 'Start operation belongs to another definition'); return { run, created: false } }
    const at = new Date().toISOString(); const run: PipelineRun = { id: randomUUID(), definitionId, operationId, revision: 1, createdAt: at, updatedAt: at, state: 'preparing', nextStep: 0, epoch: 0, approved: [], attempts: [], checkpoints: [], recoveries: [] }
    this.db.exec('BEGIN IMMEDIATE')
    try { this.db.prepare('INSERT INTO runs(id,operation_id,record_json) VALUES(?,?,?)').run(run.id, operationId, JSON.stringify(run)); this.event(run, 'run/created'); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { run, created: true }
  }
  update(id: string, revision: number | undefined, type: string, change: (run: PipelineRun) => void): PipelineRun {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.get(id)
      if (revision !== undefined && run.revision !== revision) throw new PipelineError(409, 'Pipeline changed; refresh before approving this stage')
      change(run); run.revision++; run.updatedAt = new Date().toISOString()
      this.db.prepare('UPDATE runs SET record_json=? WHERE id=?').run(JSON.stringify(run), run.id); this.event(run, type); this.db.exec('COMMIT'); return run
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private event(run: PipelineRun, type: string): void { this.db.prepare('INSERT INTO events(run_id,type,at,data_json) VALUES(?,?,?,?)').run(run.id, type, run.updatedAt, JSON.stringify({ revision: run.revision, state: run.state, nextStep: run.nextStep, epoch: run.epoch, definitionId: run.definitionId, reason: run.reason, attempts: run.attempts.length, recovery: run.recoveries.at(-1) })) }
  events(id: string, after = 0): PipelineEvent[] { this.get(id); if (!Number.isSafeInteger(after) || after < 0) throw new PipelineError(400, 'Invalid Pipeline event cursor'); return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(id, after).map(row => ({ seq: Number(row.seq), runId: String(row.run_id), type: String(row.type), at: String(row.at), data: JSON.parse(String(row.data_json)) })) }
  close(): void { this.db.close() }
}
