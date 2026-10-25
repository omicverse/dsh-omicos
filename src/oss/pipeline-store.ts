import {openPipelineExport,type PipelineExport} from './pipeline-export.js'
import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open,realpath,stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PipelineError, type PipelineDefinition, type PipelineRun, type PipelineEvent, type PipelineRunSummary, type PipelineHistoryKind, type PipelineHistoryPage, type PipelineRunWindow } from './pipeline-types.js'
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
  private exports=new Set<AbortController>();private closed=false
  private constructor(private db:Database,private file:string,private identity:{dev:number;ino:number}) {}
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
      return new PipelineStore(db,await realpath(path),await stat(path))
    } catch (error) { db.close(); throw error }
  }
  define(input: unknown): PipelineDefinition { const definition = normalizePipeline(input); this.db.prepare('INSERT OR IGNORE INTO definitions(id,document_json) VALUES(?,?)').run(definition.id, JSON.stringify(definition)); return definition }
  definition(id: string): PipelineDefinition { const row = this.db.prepare('SELECT document_json FROM definitions WHERE id=?').get(id); if (!row) throw new PipelineError(404, 'Pipeline definition not found'); const saved = JSON.parse(String(row.document_json)); if (normalizePipeline(saved).id !== id) throw new PipelineError(409, 'Pinned Pipeline definition was modified; preserve the database and inspect it'); return saved }
  definitions() { return this.db.prepare('SELECT document_json FROM definitions ORDER BY rowid DESC').all().map(row => { const { id, title, language, steps } = JSON.parse(String(row.document_json)) as PipelineDefinition; return { id, title, language, steps: steps.length } }) }
  runs(): PipelineRun[] { return this.db.prepare('SELECT record_json FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => JSON.parse(String(row.record_json))) }
  definitionPage(before = Number.MAX_SAFE_INTEGER, query = '') {
    if (!Number.isSafeInteger(before) || before < 1 || typeof query !== 'string' || query.length > 200) throw new PipelineError(400, 'Invalid Pipeline definition cursor/query')
    const rows = this.db.prepare(`SELECT rowid,id,json_extract(document_json,'$.title') AS title,json_extract(document_json,'$.language') AS language,json_array_length(document_json,'$.steps') AS steps FROM definitions WHERE rowid<? AND (?='' OR instr(id,?)>0 OR instr(lower(json_extract(document_json,'$.title')),lower(?))>0) ORDER BY rowid DESC LIMIT 51`).all(before, query, query, query)
    return { entries: rows.slice(0,50).map(row => ({ id: String(row.id), title: String(row.title), language: String(row.language), steps: Number(row.steps) })), total: Number(this.db.prepare('SELECT COUNT(*) AS total FROM definitions').get()!.total), next: rows.length > 50 ? Number(rows[49].rowid) : undefined }
  }
  runPage(before = Number.MAX_SAFE_INTEGER, query = '', state = '') {
    if (!Number.isSafeInteger(before) || before < 1 || typeof query !== 'string' || query.length > 200 || typeof state !== 'string' || (state && !['preparing','running','waiting','cancelling','canceled','failed','interrupted','succeeded'].includes(state))) throw new PipelineError(400, 'Invalid Pipeline run cursor/query/state')
    const rows = this.db.prepare(`SELECT r.rowid,r.id,json_extract(r.record_json,'$.definitionId') AS definition_id,json_extract(r.record_json,'$.operationId') AS operation_id,json_extract(r.record_json,'$.revision') AS revision,json_extract(r.record_json,'$.createdAt') AS created_at,json_extract(r.record_json,'$.updatedAt') AS updated_at,json_extract(r.record_json,'$.state') AS state,json_extract(r.record_json,'$.nextStep') AS next_step,json_extract(r.record_json,'$.epoch') AS epoch,json_extract(r.record_json,'$.reason') AS reason,json_extract(r.record_json,'$.cancelRequested') AS cancel_requested,json_array_length(r.record_json,'$.attempts') AS attempts,json_array_length(r.record_json,'$.checkpoints') AS checkpoints,json_extract(d.document_json,'$.title') AS title FROM runs r LEFT JOIN definitions d ON d.id=json_extract(r.record_json,'$.definitionId') WHERE r.rowid<? AND (?='' OR json_extract(r.record_json,'$.state')=?) AND (?='' OR instr(r.id,?)>0 OR instr(r.operation_id,?)>0 OR instr(lower(json_extract(d.document_json,'$.title')),lower(?))>0) ORDER BY r.rowid DESC LIMIT 51`).all(before, state, state, query, query, query, query)
    const entries: PipelineRunSummary[] = rows.slice(0,50).map(row => ({ id: String(row.id), definitionId: String(row.definition_id), operationId: String(row.operation_id), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at), state: String(row.state) as PipelineRun['state'], nextStep: Number(row.next_step), epoch: Number(row.epoch), reason: row.reason ? String(row.reason).slice(0,2000) : undefined, cancelRequested: row.cancel_requested === null ? undefined : Boolean(row.cancel_requested), attempts: Number(row.attempts || 0), checkpoints: Number(row.checkpoints || 0), title: row.title === null ? '[missing definition]' : String(row.title) }))
    return { entries, total: Number(this.db.prepare('SELECT COUNT(*) AS total FROM runs').get()!.total), next: rows.length > 50 ? Number(rows[49].rowid) : undefined }
  }
  recover(): void {
    let after = 0
    for (;;) { const rows = this.db.prepare("SELECT rowid,id FROM runs WHERE rowid>? AND json_extract(record_json,'$.state') IN ('preparing','running','cancelling','waiting') ORDER BY rowid LIMIT 50").all(after); if (!rows.length) return; for (const row of rows) this.update(String(row.id), undefined, 'run/interrupted', draft => { draft.state = 'interrupted'; draft.reason = 'Host stopped. Inspect partial side effects; recovery requires explicit approval.' }); after = Number(rows.at(-1)!.rowid) }
  }
  get(id: string): PipelineRun { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new PipelineError(400, 'Invalid Pipeline run id'); const row = this.db.prepare('SELECT record_json FROM runs WHERE id=?').get(id); if (!row) throw new PipelineError(404, 'Pipeline run not found'); const run = JSON.parse(String(row.record_json)) as PipelineRun; if (run.id !== id || !Number.isSafeInteger(run.revision) || run.revision < 1 || !/^[a-f0-9]{64}$/.test(run.definitionId)) throw new PipelineError(409, 'Invalid persisted Pipeline identity'); return run }
  private header(id:string):{run:Omit<PipelineRun,'attempts'|'checkpoints'|'recoveries'|'approved'>;counts:Record<PipelineHistoryKind,number>}{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new PipelineError(400,'Invalid Pipeline run id')
    const row=this.db.prepare("SELECT json_remove(record_json,'$.attempts','$.checkpoints','$.recoveries','$.approved') AS header,json_array_length(record_json,'$.attempts') AS attempts,json_array_length(record_json,'$.checkpoints') AS checkpoints,json_array_length(record_json,'$.recoveries') AS recoveries FROM runs WHERE id=?").get(id)
    if(!row)throw new PipelineError(404,'Pipeline run not found');const run=JSON.parse(String(row.header));if(run.id!==id||!Number.isSafeInteger(run.revision)||run.revision<1||!/^[a-f0-9]{64}$/.test(run.definitionId))throw new PipelineError(409,'Invalid persisted Pipeline identity')
    return {run,counts:{attempts:Number(row.attempts),checkpoints:Number(row.checkpoints),recoveries:Number(row.recoveries)}}
  }
  historyPage(id:string,kind:PipelineHistoryKind,before=Number.MAX_SAFE_INTEGER,revision?:number):PipelineHistoryPage{
    if(!['attempts','checkpoints','recoveries'].includes(kind)||!Number.isSafeInteger(before)||before<0||revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw new PipelineError(400,'Invalid Pipeline history kind/cursor/revision')
    if(before!==Number.MAX_SAFE_INTEGER&&revision===undefined)throw new PipelineError(400,'A run revision is required for older history pages')
    const header=this.header(id);if(revision!==undefined&&revision!==header.run.revision)throw new PipelineError(409,'Pipeline changed; restart historical paging at its current revision')
    const rows=this.db.prepare(`SELECT CAST(a.key AS INTEGER) AS position,json_remove(a.value,'$.environment','$.expectedEnvironment','$.observedEnvironment','$.files','$.artifacts','$.methodReviews','$.outputTail','$.error') AS summary,substr(json_extract(a.value,'$.outputTail'),-1000) AS output_tail,substr(json_extract(a.value,'$.error'),1,1000) AS error,json_array_length(a.value,'$.files') AS files,json_array_length(a.value,'$.artifacts') AS artifacts FROM runs r,json_each(r.record_json,'$.${kind}') a WHERE r.id=? AND CAST(a.key AS INTEGER)<? ORDER BY CAST(a.key AS INTEGER) DESC LIMIT 21`).all(id,before)
    const entries=rows.slice(0,20).map(row=>{const value=JSON.parse(String(row.summary));if(kind==='attempts')return {position:Number(row.position),id:value.id,step:value.step,kind:value.kind,operationId:value.operationId,executionId:value.executionId,state:value.state,codeHash:value.codeHash,outputHash:value.outputHash,...row.output_tail?{outputTail:String(row.output_tail)}:{},...row.error?{error:String(row.error)}:{},files:Number(row.files||0),artifacts:Number(row.artifacts||0)};if(kind==='checkpoints')return {position:Number(row.position),attemptId:value.attemptId,step:value.step,files:Number(row.files||0)};return {position:Number(row.position),epoch:value.epoch,action:value.action,checkpointAttemptId:value.checkpointAttemptId,sideEffectsReviewed:value.sideEffectsReviewed,allowEnvironmentChange:value.allowEnvironmentChange,at:value.at,expectedFingerprint:value.expectedFingerprint,observedFingerprint:value.observedFingerprint}})
    return {runId:id,revision:header.run.revision,kind,entries,total:header.counts[kind],...rows.length>20?{next:Number(rows[19].position)}:{}}
  }
  historyItem(id:string,kind:PipelineHistoryKind,position:number,revision:number):unknown{
    if(!['attempts','checkpoints','recoveries'].includes(kind)||!Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(revision)||revision<1)throw new PipelineError(400,'Invalid Pipeline history item')
    const header=this.header(id);if(header.run.revision!==revision)throw new PipelineError(409,'Pipeline changed; restart historical paging at its current revision')
    const row=this.db.prepare(`SELECT CASE WHEN length(CAST(a.value AS BLOB))<=2000000 THEN a.value ELSE NULL END AS record FROM runs r,json_each(r.record_json,'$.${kind}') a WHERE r.id=? AND CAST(a.key AS INTEGER)=?`).get(id,position)
    if(!row)throw new PipelineError(404,'Pipeline history item not found');if(row.record===null)throw new PipelineError(413,'History item exceeds 2 MB; inspect the preserved database or individual execution receipt')
    return {runId:id,revision,kind,position,record:JSON.parse(String(row.record))}
  }
  window(id:string):PipelineRunWindow{
    const {run,counts}=this.header(id)
    return {...run,reason:run.reason?.slice(0,2000),counts,windowed:true,attempts:this.historyPage(id,'attempts',undefined,run.revision).entries as PipelineRunWindow['attempts'],checkpoints:this.historyPage(id,'checkpoints',undefined,run.revision).entries as PipelineRunWindow['checkpoints'],recoveries:this.historyPage(id,'recoveries',undefined,run.revision).entries as PipelineRunWindow['recoveries']}
  }
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
  events(id: string, after = 0): PipelineEvent[] { this.header(id); if (!Number.isSafeInteger(after) || after < 0) throw new PipelineError(400, 'Invalid Pipeline event cursor'); return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(id, after).map(row => ({ seq: Number(row.seq), runId: String(row.run_id), type: String(row.type), at: String(row.at), data: JSON.parse(String(row.data_json)) })) }
  figureCandidates(cursor?: string) {
    const parts = cursor === undefined ? [Number.MAX_SAFE_INTEGER, -1, -1] : cursor.split(':').map(Number)
    if (parts.length !== 3 || !Number.isSafeInteger(parts[0]) || parts[0] < 1 || parts.slice(1).some(value => !Number.isSafeInteger(value) || value < -1)) throw new PipelineError(400, 'Invalid Pipeline artifact cursor')
    const [row, attempt, index] = parts
    const rows = this.db.prepare(`SELECT r.rowid AS row_id,r.id AS run_id,json_extract(r.record_json,'$.definitionId') AS definition_id,a.key AS attempt_index,b.key AS artifact_index,json_extract(a.value,'$.executionId') AS execution_id,json_extract(a.value,'$.state') AS state,b.value AS artifact_json FROM runs r,json_each(r.record_json,'$.attempts') a,json_each(a.value,'$.artifacts') b WHERE (r.rowid<? OR (r.rowid=? AND (CAST(a.key AS INTEGER)>? OR (CAST(a.key AS INTEGER)=? AND CAST(b.key AS INTEGER)>?)))) ORDER BY r.rowid DESC,CAST(a.key AS INTEGER),CAST(b.key AS INTEGER) LIMIT 51`).all(row, row, attempt, attempt, index)
    return { entries: rows.slice(0, 50).map(item => ({ source: { kind: 'pipeline' as const, language: this.definition(String(item.definition_id)).language, runId: String(item.run_id), executionId: String(item.execution_id), artifactId: JSON.parse(String(item.artifact_json)).id }, artifact: JSON.parse(String(item.artifact_json)), state: String(item.state) })), next: rows.length > 50 ? `${rows[49].row_id}:${rows[49].attempt_index}:${rows[49].artifact_index}` : undefined }
  }
  async exportRun(id:string,revision:number,signal:AbortSignal):Promise<PipelineExport>{
    if(this.closed)throw new PipelineError(503,'Pipeline store is closed');const own=new AbortController();this.exports.add(own)
    try{return await openPipelineExport(this.file,this.identity,id,revision,AbortSignal.any([signal,own.signal]),value=>normalizePipeline(value).id,()=>this.exports.delete(own))}catch(error){this.exports.delete(own);throw error}
  }
  close():void{if(this.closed)return;this.closed=true;for(const controller of this.exports)controller.abort(new Error('Pipeline store closed'));this.exports.clear();this.db.close()}
}
