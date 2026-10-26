import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Execution } from './types.js'
import { ResearchPlanError, type ResearchDefinition, type ResearchPlan, type ResearchPlanDraft, type PlanDecision, type PlanEvidenceSource, type PlanEvidence } from './research-plan-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const canonical = (value: any): string => JSON.stringify(sort(value))
function sort(value: any): any { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, sort(value[key])])) : value }
const text = (v: unknown, field: string, max: number, empty = false): string => { if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) throw new ResearchPlanError(400, `Invalid plan ${field}`); return v }
const refs = (v: unknown, field: string): string[] => { if (!Array.isArray(v) || v.length > 30) throw new ResearchPlanError(400, `Use at most 30 ${field}`); return v.map(item => text(item, field, 2000)) }
const identity = (v: unknown) => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(v)) throw new ResearchPlanError(400, 'Invalid plan/operation identity'); return v }
const cursor = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw new ResearchPlanError(400, 'Invalid plan page cursor'); return value }
const fingerprint = (node: ResearchPlan) => { const { digest: _, ...body } = node; return hash(canonical(body)) }
export function researchDefinition(value: ResearchDefinition): ResearchDefinition {
  if (!value || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 100) throw new ResearchPlanError(400, 'A plan needs 1–100 steps')
  const definition = { title: text(value.title, 'title', 200), objective: text(value.objective, 'objective', 20000), steps: value.steps.map(step => {
    if (!step) throw new ResearchPlanError(400, 'Invalid plan step')
    return { id: identity(step.id), title: text(step.title, 'step title', 200), inputs: refs(step.inputs, 'inputs'), outputs: refs(step.outputs, 'outputs'), methods: refs(step.methods, 'methods'), risk: text(step.risk, 'risk', 4000), acceptance: text(step.acceptance, 'acceptance', 4000) }
  }) }
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length) throw new ResearchPlanError(400, 'Plan step IDs must be unique')
  if (Buffer.byteLength(JSON.stringify(definition)) > 250000) throw new ResearchPlanError(413, 'Plan definition exceeds 250 KB')
  return definition
}
/** Declarative plans are human governance records, never execution permission or scientific proof. */
export class ResearchPlans {
  private writes: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposing?: Promise<void>
  private constructor(private db: Database, private resolve: (source: PlanEvidenceSource) => Promise<Execution>) {}
  static async open(workspace: string, resolve: (source: PlanEvidenceSource) => Promise<Execution>): Promise<ResearchPlans> {
    const path = join(workspace, '.omicos-oss', 'research-plans.sqlite'); const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 1 || (application !== 0 && application !== 0x4f504c4e) || (version && application !== 0x4f504c4e)) throw new Error('Unsupported research plan database; preserve it and use a compatible runtime')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (!version) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Refusing to adopt unknown research plan database')
        db.exec(`BEGIN IMMEDIATE; CREATE TABLE plans(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,revision)); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,plan_id TEXT NOT NULL); PRAGMA application_id=${0x4f504c4e}; PRAGMA user_version=1; COMMIT;`)
      }
      return new ResearchPlans(db, resolve)
    } catch (error) { db.close(); throw error }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> { if (this.closing) return Promise.reject(new ResearchPlanError(409, 'Research plans are closing')); const pending = this.writes.then(action); this.writes = pending.catch(() => {}); return pending }
  get(id: string, revision?: number): ResearchPlan {
    identity(id); if (revision !== undefined) cursor(revision)
    const row = revision === undefined ? this.db.prepare('SELECT record_json FROM plans WHERE id=?').get(id) : this.db.prepare('SELECT record_json FROM revisions WHERE id=? AND revision=?').get(id, revision)
    if (!row) throw new ResearchPlanError(404, 'Research plan/revision not found')
    const node = JSON.parse(String(row.record_json)) as ResearchPlan
    if (node.id !== id || (revision !== undefined && node.revision !== revision) || node.digest !== fingerprint(node) || node.definitionSha256 !== hash(canonical(node.definition))) throw new ResearchPlanError(409, 'Plan revision identity changed; preserve and inspect the database')
    return node
  }
  list(query = '', before = Number.MAX_SAFE_INTEGER) {
    cursor(before); text(query, 'search', 200, true)
    const rows = this.db.prepare(`SELECT rowid,id FROM plans WHERE rowid<? AND (?='' OR instr(lower(json_extract(record_json,'$.definition.title') || char(10) || json_extract(record_json,'$.definition.objective')),lower(?))>0) ORDER BY rowid DESC LIMIT 51`).all(before, query, query)
    return { entries: rows.slice(0,50).map(row => { const node = this.get(String(row.id)); return { id: node.id, revision: node.revision, title: node.definition.title, status: node.status, steps: node.definition.steps.length, completed: node.assessments.filter(step => step.state === 'completed').length, skipped: node.assessments.filter(step => step.state === 'skipped').length, updatedAt: node.updatedAt } }), next: rows.length > 50 ? Number(rows[49].rowid) : undefined }
  }
  history(id: string, before = Number.MAX_SAFE_INTEGER) { this.get(id); cursor(before); const rows = this.db.prepare('SELECT revision FROM revisions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT 51').all(id, before); return { revisions: rows.slice(0,50).map(row => this.get(id, Number(row.revision))), next: rows.length > 50 ? Number(rows[49].revision) : undefined } }
  private replay(operation: string, request: unknown): ResearchPlan | undefined {
    identity(operation); const row = this.db.prepare('SELECT request_hash,plan_id FROM operations WHERE id=?').get(operation)
    if (!row) return
    if (row.request_hash !== hash(canonical(request))) throw new ResearchPlanError(409, 'Plan operation belongs to another request')
    return this.get(String(row.plan_id))
  }
  private commit(node: ResearchPlan, operation: string, request: unknown): ResearchPlan {
    node.digest = fingerprint(node); const record = JSON.stringify(node)
    this.db.exec('BEGIN IMMEDIATE')
    try { this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(node.id, node.revision, record); this.db.prepare('INSERT INTO plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(node.id, record); this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operation, hash(canonical(request)), node.id); this.db.exec('COMMIT'); return node } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  propose(input: ResearchPlanDraft, actor: string): Promise<ResearchPlan> {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object') throw new ResearchPlanError(400, 'Plan proposal required')
      const request = { action: 'propose', input, actor }; const replay = this.replay(input.operationId, request); if (replay) return replay
      if (input.id === undefined && input.revision !== undefined) throw new ResearchPlanError(400, 'A plan revision requires its existing plan ID')
      const old = input.id !== undefined ? this.get(input.id) : undefined
      if (old && old.revision !== input.revision) throw new ResearchPlanError(409, 'Plan changed; reload and merge before proposing')
      const definition = researchDefinition(input.definition); const at = new Date().toISOString()
      return this.commit({ id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, definition, definitionSha256: hash(canonical(definition)), status: 'draft', assessments: [], actor, note: 'Definition proposed; explicit human approval required.', action: 'propose', createdAt: old?.createdAt || at, updatedAt: at, digest: '' }, input.operationId, request)
    })
  }
  decide(input: PlanDecision): Promise<ResearchPlan> {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object') throw new ResearchPlanError(400, 'Human plan decision required')
      const actor = 'user:workbench'; const request = { action: 'decide', input, actor }; const replay = this.replay(input.operationId, request); if (replay) return replay
      const node = this.get(input.id); if (node.revision !== input.revision) throw new ResearchPlanError(409, 'Plan changed; reload before deciding')
      const note = text(input.note, 'human decision note', 4000); const at = new Date().toISOString()
      if (['approve', 'reject', 'withdraw'].includes(input.action)) {
        if (input.action === 'withdraw') { if (node.status === 'withdrawn') throw new ResearchPlanError(409, 'Plan is already withdrawn'); node.status = 'withdrawn'; delete node.approval }
        else {
          if (node.status !== 'draft') throw new ResearchPlanError(409, 'Only a current draft can be approved/rejected; propose a revision first')
          node.status = input.action === 'approve' ? 'approved' : 'rejected'
          if (input.action === 'approve') node.approval = { actor, at, note, definitionSha256: node.definitionSha256 }
        }
      } else if (['complete', 'block', 'skip', 'reopen'].includes(input.action)) {
        if (node.status !== 'approved' || node.approval?.definitionSha256 !== node.definitionSha256) throw new ResearchPlanError(409, 'Task assessment requires the currently approved definition')
        const index = node.definition.steps.findIndex(step => step.id === input.stepId); if (index < 0) throw new ResearchPlanError(400, 'Unknown plan step')
        const old = node.assessments.find(step => step.stepId === input.stepId)
        if (input.action === 'reopen') {
          if (!old) throw new ResearchPlanError(409, 'This step has no assessment to reopen')
          // Later assessments depend on this ordered step. Their immutable history stays available.
          const affected = new Set(node.definition.steps.slice(index).map(step => step.id)); node.assessments = node.assessments.filter(step => !affected.has(step.stepId))
        } else {
          if (old && old.state !== 'blocked') throw new ResearchPlanError(409, 'Reopen an assessed task before changing it')
          if (input.action !== 'block' && node.definition.steps.slice(0,index).some(step => !node.assessments.some(item => item.stepId === step.id && ['completed','skipped'].includes(item.state)))) throw new ResearchPlanError(409, 'Assess preceding steps or explicitly skip them first')
          const sources = input.evidence ?? []; if (!Array.isArray(sources) || sources.length > 10) throw new ResearchPlanError(400, 'Use at most 10 execution receipts per assessment')
          const evidence: PlanEvidence[] = []
          for (const source of sources) {
            if (!source || !['project','pipeline'].includes(source.kind)) throw new ResearchPlanError(400, 'Invalid plan evidence source')
            identity(source.executionId); if (source.kind === 'pipeline') identity(source.runId)
            if (evidence.some(item => item.kind === source.kind && item.executionId === source.executionId && (source.kind === 'project' || item.runId === source.runId))) throw new ResearchPlanError(400, 'Duplicate plan evidence')
            const job = await this.resolve(source)
            if (job.id !== source.executionId) throw new ResearchPlanError(409, 'Execution receipt identity mismatch')
            if (!['succeeded','failed','canceled','interrupted'].includes(job.state)) throw new ResearchPlanError(409, 'Wait for a terminal execution receipt')
            if (input.action === 'complete' && job.state !== 'succeeded') throw new ResearchPlanError(409, 'A failed/canceled/interrupted receipt cannot complete a task')
            evidence.push({ kind: source.kind, executionId: job.id, ...(source.kind === 'pipeline' ? { runId: source.runId } : {}), language: job.language, state: job.state, codeSha256: hash(job.code), outputSha256: hash(job.output), environment: job.environment, artifacts: job.artifacts.map(({ id,sha256,bytes }) => ({ id,sha256,bytes })), recordedAt: at })
          }
          if (input.action === 'complete' && !evidence.length) throw new ResearchPlanError(400, 'Completion requires a successful execution receipt and human assessment')
          node.assessments = node.assessments.filter(step => step.stepId !== input.stepId).concat({ stepId: input.stepId!, state: input.action === 'complete' ? 'completed' : input.action === 'block' ? 'blocked' : 'skipped', note, actor, at, evidence })
        }
      } else throw new ResearchPlanError(400, 'Unknown plan decision')
      if (['complete','block','skip','reopen'].includes(input.action)) node.decisionStepId = input.stepId; else delete node.decisionStepId
      node.revision++; node.actor = actor; node.note = note; node.action = input.action; node.updatedAt = at
      return this.commit(node, input.operationId, request)
    })
  }
  dispose(): Promise<void> { this.closing = true; return this.disposing ||= this.writes.then(() => this.db.close()) }
}
