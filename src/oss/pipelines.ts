import { METHOD_PREFIX } from './methods.js'
import type { MethodAssessment } from './method-types.js'
import type { PipelineListQuery } from './pipeline-types.js'
import { artifactBytes } from './artifact-bytes.js'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ScienceService } from './science.js'
import { ScienceLedger } from './ledger.js'
import { workspacePath } from './files.js'
import { PipelineStore, digest, normalizePipeline } from './pipeline-store.js'
import { PipelineError, type FileEvidence, type PipelineRun, type PipelineDefinition, type PipelineAttempt, type PipelineReference } from './pipeline-types.js'
import type { Execution } from './types.js'

const requireMethodRegistry = (references: readonly PipelineReference[]): MethodAssessment[] => { if (references.some(reference => reference.id.trim().toLowerCase().startsWith(METHOD_PREFIX))) throw new PipelineError(503, 'Managed method registry is unavailable; code was not executed'); return [] }
const stopped = new Set(['failed', 'canceled', 'interrupted', 'succeeded'])
export class PipelineService {
  private workers = new Map<string, ScienceService>()
  private active = new Map<string, Promise<void>>()
  private controllers = new Map<string, AbortController>()
  private closing = false
  private disposing?: Promise<void>
  private constructor(readonly workspace: string, readonly store: PipelineStore, private python: string, private rscript: string, private envNames: readonly string[], private sensitive: readonly string[], private pythonUnavailable?: string, private isolatedPython = false, private validateMethods: (references: readonly PipelineReference[]) => MethodAssessment[] = requireMethodRegistry) {}
  static async open(workspace: string, python: string, rscript: string, envNames: readonly string[], sensitive: readonly string[], pythonUnavailable?: string, isolatedPython = false, validateMethods = requireMethodRegistry): Promise<PipelineService> {
    const store = await PipelineStore.open(workspace)
    try { store.recover(); return new PipelineService(workspace, store, python, rscript, envNames, sensitive, pythonUnavailable, isolatedPython, validateMethods) } catch (error) { store.close(); throw error }
  }
  private async directory(runId: string): Promise<string> {
    this.store.get(runId)
    const parent = join(this.workspace, '.omicos-oss', 'pipeline-runs'); await mkdir(parent, { recursive: true, mode: 0o700 })
    if (await realpath(parent) !== parent) throw new PipelineError(403, 'Pipeline runtime directory cannot be a symbolic link')
    const directory = join(parent, runId); await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) throw new PipelineError(403, 'Pipeline run directory cannot be a symbolic link')
    return directory
  }
  private assertOpen() { if (this.closing) throw new PipelineError(503, 'Pipeline service is shutting down') }
  define(input: unknown) { this.assertOpen(); const definition = normalizePipeline(input); this.validateMethods(definition.references); return this.store.define(definition) }
  list(query: PipelineListQuery = {}) { const definitions = this.store.definitionPage(query.definitionsBefore, query.definitionQuery); const runs = this.store.runPage(query.runsBefore, query.runQuery, query.state); return { definitions: definitions.entries, runs: runs.entries, definitionPage: { total: definitions.total, next: definitions.next }, runPage: { total: runs.total, next: runs.next } } }
  get(id: string) { return this.store.get(id) }
  private checkFilesAvailable(definitionId: string, ownId?: string): void {
    const definition = this.store.definition(definitionId)
    const writes = (definition: PipelineDefinition) => definition.steps.flatMap(step => [...step.outputs, ...step.checkpoint?.files || []])
    const proposed = writes(definition)
    for (const id of new Set([...this.active.keys(), ...this.workers.keys()])) {
      if (id === ownId) continue
      const other = this.store.definition(this.store.get(id).definitionId); const occupied = writes(other)
      if (proposed.some(path => [...occupied, ...other.inputs].includes(path)) || definition.inputs.some(path => occupied.includes(path))) throw new PipelineError(409, 'Declared input/output files overlap another active or waiting Pipeline; finish or cancel it first')
    }
  }
  start(definitionId: string, operationId: string): PipelineRun {
    this.assertOpen()
    const existing = this.store.byOperation(operationId)
    if (existing) { if (existing.definitionId !== definitionId) throw new PipelineError(409, 'Start operation belongs to another definition'); return existing }
    this.validateMethods(this.store.definition(definitionId).references)
    if (new Set([...this.active.keys(), ...this.workers.keys()]).size >= 4) throw new PipelineError(409, 'Four local Pipeline runs already hold kernels; finish or cancel a waiting run first')
    if (this.pythonUnavailable && this.store.definition(definitionId).language === 'python') throw new PipelineError(409, this.pythonUnavailable)
    this.checkFilesAvailable(definitionId)
    const { run, created } = this.store.create(definitionId, operationId)
    if (created) this.launch(run.id)
    return run
  }
  private async files(paths: readonly string[], signal?: AbortSignal): Promise<FileEvidence[]> {
    const result: FileEvidence[] = []
    for (const path of [...new Set(paths)]) {
      signal?.throwIfAborted()
      const file = await workspacePath(this.workspace, path, this.sensitive); const before = await stat(file)
      if (!before.isFile()) throw new PipelineError(400, `Not a regular data file: ${path}`)
      const hash = createHash('sha256'); const stream = createReadStream(file, { signal })
      for await (const chunk of stream) hash.update(chunk)
      const after = await stat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new PipelineError(409, `File changed while hashing: ${path}`)
      result.push({ path, bytes: after.size, sha256: hash.digest('hex') })
    }
    return result
  }
  private async verify(evidence: readonly FileEvidence[], signal?: AbortSignal): Promise<void> {
    const actual = await this.files(evidence.map(file => file.path), signal)
    for (let index = 0; index < evidence.length; index++) if (actual[index]?.sha256 !== evidence[index].sha256 || actual[index]?.bytes !== evidence[index].bytes) throw new PipelineError(409, `Declared input/checkpoint changed: ${evidence[index].path}`)
  }
  private async worker(run: PipelineRun, definition: PipelineDefinition, fresh = false): Promise<ScienceService> {
    this.validateMethods(definition.references)
    if (this.pythonUnavailable && definition.language === 'python') throw new PipelineError(409, this.pythonUnavailable)
    let service = this.workers.get(run.id)
    if (fresh && service) { await service.dispose(); this.workers.delete(run.id); service = undefined }
    if (!service) {
      service = await ScienceService.open(await this.directory(run.id), definition.language === 'r' ? this.rscript : this.python, definition.language, this.envNames)
      if (definition.language === 'python') service.configureColdInterpreter(this.python, this.pythonUnavailable, this.isolatedPython)
      this.workers.set(run.id, service)
    }
    return service
  }
  private source(definition: PipelineDefinition, code: string): string {
    const cwd = JSON.stringify(this.workspace); const bindings = JSON.stringify(JSON.stringify(definition.parameters))
    return definition.language === 'r' ? `setwd(${cwd})\npipeline_parameters <- jsonlite::fromJSON(${bindings}, simplifyVector=FALSE)\n${code}` : `import os as __omicos_os, json as __omicos_json\n__omicos_os.chdir(${cwd})\npipeline_parameters = __omicos_json.loads(${bindings})\n${code}`
  }
  private async settled(worker: ScienceService, id: string): Promise<Execution> {
    return new Promise(resolve => {
      const check = () => { const execution = worker.get(id); if (!execution || !stopped.has(execution.state)) return; worker.off('change', check); resolve(execution) }
      worker.on('change', check); check()
    })
  }
  private launch(id: string, recovery?: { checkpointAttemptId?: string; restart?: boolean; allowEnvironmentChange?: boolean }): void {
    const controller = new AbortController(); this.controllers.set(id, controller)
    const task = this.pump(id, controller.signal, recovery).catch(error => {
      this.store.update(id, undefined, 'run/stopped', run => { run.state = this.closing ? 'interrupted' : run.cancelRequested ? 'canceled' : 'failed'; run.reason = String(error instanceof Error ? error.message : error).slice(0, 8000) })
    }).finally(async () => {
      let waiting = false; try { waiting = this.store.get(id).state === 'waiting' } catch {}
      if (!waiting) { const worker = this.workers.get(id); if (worker) { await worker.dispose(); this.workers.delete(id) } }
      this.active.delete(id); this.controllers.delete(id)
    })
    this.active.set(id, task)
    void task.catch(() => {}) // Persistence errors remain observable at shutdown; no unhandled background rejection.
  }
  private async execute(id: string, worker: ScienceService, definition: PipelineDefinition, step: number, kind: PipelineAttempt['kind'], code: string): Promise<Execution> {
    const run = this.store.get(id)
    this.validateMethods(definition.references)
    if (!run.kernelGeneration) throw new PipelineError(409, 'Pipeline namespace has no live generation; code was not submitted')
    if (run.cancelRequested || this.closing) throw new Error('Execution canceled before submission')
    const operationId = `pipeline-${id}-${run.epoch}-${kind}-${step}`
    const attempt: PipelineAttempt = { id: randomUUID(), step, kind, operationId, state: 'reserved' }
    this.store.update(id, undefined, 'execution/reserved', draft => { draft.attempts.push(attempt) })
    const job = await worker.submit(this.source(definition, code), operationId, `pipeline:${id}`, run.kernelGeneration, dispatch => {
      const reviews = this.validateMethods(definition.references)
      if (dispatch && reviews.length && JSON.stringify(this.store.get(id).attempts.find(item => item.id === attempt.id)?.methodReviews) !== JSON.stringify(reviews)) this.store.update(id, undefined, 'methods/validated', draft => { draft.attempts.find(item => item.id === attempt.id)!.methodReviews = reviews })
    })
    this.store.update(id, undefined, 'execution/submitted', draft => { draft.attempts.find(item => item.id === attempt.id)!.executionId = job.id })
    if (this.store.get(id).cancelRequested) await worker.cancel(job.id)
    const result = await this.settled(worker, job.id)
    this.store.update(id, undefined, `execution/${result.state}`, draft => {
      Object.assign(draft.attempts.find(item => item.id === attempt.id)!, { executionId: result.id, state: result.state, outputTail: result.output.slice(-8000), error: result.error?.slice(-8000), artifacts: result.artifacts, environment: result.environment, codeHash: digest(result.code), outputHash: digest(result.output) })
      draft.kernelGeneration = result.kernelGeneration
    })
    return result
  }
  private async pump(id: string, signal: AbortSignal, recovery?: { checkpointAttemptId?: string; restart?: boolean; allowEnvironmentChange?: boolean }): Promise<void> {
    let run = this.store.get(id); const definition = this.store.definition(run.definitionId)
    if (run.inputs) await this.verify(run.inputs, signal)
    else { const inputs = await this.files(definition.inputs, signal); this.store.update(id, undefined, 'inputs/pinned', draft => { draft.inputs = inputs }) }
    let checkpoint = recovery?.checkpointAttemptId ? run.checkpoints.find(checkpoint => checkpoint.attemptId === recovery.checkpointAttemptId) : undefined
    if (recovery?.checkpointAttemptId && !checkpoint) throw new PipelineError(400, 'Checkpoint not found')
    if (checkpoint) await this.verify(checkpoint.files, signal)
    signal.throwIfAborted()
    const worker = await this.worker(run, definition, Boolean(recovery))
    if (!recovery && run.kernelGeneration && (worker.kernelState().state !== 'ready' || worker.kernelState().generation !== run.kernelGeneration)) throw new PipelineError(409, 'Namespace lost; restore a checkpoint or explicitly restart instead')
    signal.throwIfAborted()
    const environment = await worker.prepare()
    signal.throwIfAborted()
    if (recovery) this.store.update(id, undefined, 'environment/observed', draft => { Object.assign(draft.recoveries.at(-1)!, { expectedFingerprint: run.environment?.fingerprint, observedFingerprint: environment.fingerprint, expectedEnvironment: run.environment, observedEnvironment: environment }) })
    const preparedKernel = worker.kernelState()
    if (preparedKernel.state !== 'ready' || !preparedKernel.generation) throw new PipelineError(409, 'Pipeline namespace was lost during environment preparation')
    if (!recovery && run.kernelGeneration && preparedKernel.generation !== run.kernelGeneration) throw new PipelineError(409, 'Pipeline namespace changed; code was not submitted')
    if (run.environment && run.environment.fingerprint !== environment.fingerprint && !recovery?.allowEnvironmentChange) throw new PipelineError(409, 'Environment changed. Review package/interpreter differences and explicitly accept before recovery code runs.')
    this.store.update(id, undefined, recovery ? 'recovery/prepared' : 'environment/pinned', draft => { draft.environment = environment; draft.kernelGeneration = preparedKernel.generation; draft.state = 'running'; draft.reason = undefined })
    if (checkpoint) {
      const restore = definition.steps[checkpoint.step].checkpoint
      if (!restore) throw new PipelineError(409, 'Pinned definition no longer contains the selected checkpoint')
      const result = await this.execute(id, worker, definition, checkpoint.step, 'restore', restore.restoreCode)
      if (!this.completed(id, result)) return
      this.store.update(id, undefined, 'checkpoint/restored', draft => { draft.nextStep = checkpoint!.step + 1 })
    }
    for (;;) {
      run = this.store.get(id)
      if (this.closing) throw new Error('Host stopped; execution outcome may be partial')
      if (run.cancelRequested) { this.store.update(id, undefined, 'run/canceled', draft => { draft.state = 'canceled'; draft.reason = 'Canceled; inspect partial side effects before recovery.' }); return }
      const step = definition.steps[run.nextStep]
      if (!step) { this.store.update(id, undefined, 'run/succeeded', draft => { draft.state = 'succeeded' }); return }
      if (step.gate && !run.approved.includes(`${run.epoch}:${run.nextStep}`)) { this.store.update(id, undefined, 'approval/required', draft => { draft.state = 'waiting'; draft.reason = `Human decision required: ${step.title}` }); return }
      const result = await this.execute(id, worker, definition, run.nextStep, 'step', step.code)
      if (!this.completed(id, result)) return
      const outputs = await this.files([...step.outputs, ...step.checkpoint?.files || []], signal)
      this.store.update(id, undefined, 'step/committed', draft => {
        draft.attempts.at(-1)!.files = outputs
        if (step.checkpoint) draft.checkpoints.push({ attemptId: draft.attempts.at(-1)!.id, step: run.nextStep, files: outputs.filter(file => step.checkpoint!.files.includes(file.path)) })
        draft.nextStep++
      })
    }
  }
  private completed(id: string, execution: Execution): boolean {
    const run = this.store.get(id)
    if (execution.state === 'succeeded' && !run.cancelRequested && !this.closing) return true
    this.store.update(id, undefined, 'run/stopped', draft => { draft.state = this.closing ? 'interrupted' : draft.cancelRequested || execution.state === 'canceled' ? 'canceled' : execution.state === 'interrupted' ? 'interrupted' : 'failed'; draft.reason = execution.error || 'Stopped; inspect partial namespace/file changes before recovery.' })
    return false
  }
  async control(id: string, revision: number, action: 'continue' | 'checkpoint' | 'restart' | 'cancel' | 'reject', options: { checkpointAttemptId?: string; sideEffectsReviewed?: boolean; allowEnvironmentChange?: boolean } = {}): Promise<PipelineRun> {
    this.assertOpen(); let run = this.store.get(id)
    if (action === 'cancel') {
      if (stopped.has(run.state)) return run
      const updated = this.store.update(id, undefined, 'run/cancel-requested', draft => { draft.cancelRequested = true; draft.state = this.active.has(id) ? 'cancelling' : 'canceled' })
      this.controllers.get(id)?.abort(new Error('Cancellation requested'))
      if (!this.active.has(id)) { const idle = this.workers.get(id); await idle?.dispose(); this.workers.delete(id) }
      const worker = this.workers.get(id); const execution = worker?.snapshot().executions.at(-1)
      if (worker && execution && !stopped.has(execution.state)) await worker.cancel(execution.id)
      return updated
    }
    if (run.revision !== revision) throw new PipelineError(409, 'Pipeline changed; refresh before approving this stage')
    // A visible gate/terminal receipt may precede final worker disposal. Await
    // that exact task, then recheck CAS; never recover into its dying namespace.
    const settling = this.active.get(id)
    if (settling && (run.state === 'waiting' || stopped.has(run.state))) { await settling; this.assertOpen(); run = this.store.get(id) }
    if (run.revision !== revision) throw new PipelineError(409, 'Pipeline changed; refresh before approving this stage')
    if (this.active.has(id)) throw new PipelineError(409, 'Pipeline is still active; cancel or wait for its current execution')
    if (action === 'reject') {
      if (run.state !== 'waiting') throw new PipelineError(409, 'No human gate is pending')
      const rejected = this.store.update(id, revision, 'approval/rejected', draft => { draft.state = 'canceled'; draft.reason = 'Human rejected this stage.' })
      await this.workers.get(id)?.dispose(); this.workers.delete(id); return rejected
    }
    this.validateMethods(this.store.definition(run.definitionId).references)
    if (action === 'continue') {
      if (run.state !== 'waiting') throw new PipelineError(409, 'Only a waiting gate can continue in its live namespace')
      const worker = this.workers.get(id); const kernel = worker?.kernelState()
      if (!kernel || kernel.state !== 'ready' || kernel.generation !== run.kernelGeneration) throw new PipelineError(409, 'Namespace lost; restore a checkpoint or explicitly restart instead')
      await this.verify(run.inputs || [])
      const checkpoint = run.checkpoints.at(-1); if (checkpoint) await this.verify(checkpoint.files)
      const updated = this.store.update(id, revision, 'approval/granted', draft => { draft.approved.push(`${draft.epoch}:${draft.nextStep}`); draft.state = 'running'; draft.reason = undefined })
      this.launch(id); return updated
    }
    if (!['checkpoint', 'restart'].includes(action) || !['waiting', 'failed', 'canceled', 'interrupted'].includes(run.state)) throw new PipelineError(409, 'This run cannot use the requested recovery action')
    if (options.sideEffectsReviewed !== true) throw new PipelineError(400, 'Review possible partial side effects before recovery/recomputation')
    if (action === 'checkpoint' && !run.checkpoints.some(checkpoint => checkpoint.attemptId === options.checkpointAttemptId && checkpoint.step < run.nextStep)) throw new PipelineError(400, 'Select a previously completed checkpoint before the current stage')
    this.checkFilesAvailable(run.definitionId, id)
    const held = new Set([...this.active.keys(), ...this.workers.keys()])
    if (!held.has(id) && held.size >= 4) throw new PipelineError(409, 'Finish or cancel a waiting run before allocating another local kernel')
    const updated = this.store.update(id, revision, `recovery/${action}-approved`, draft => { draft.epoch++; draft.recoveries.push({ epoch: draft.epoch, action, checkpointAttemptId: options.checkpointAttemptId, sideEffectsReviewed: true, allowEnvironmentChange: options.allowEnvironmentChange === true, at: new Date().toISOString() }); draft.state = 'preparing'; draft.cancelRequested = false; draft.reason = undefined; if (action === 'restart') draft.nextStep = 0 })
    this.launch(id, { ...(action === 'checkpoint' ? { checkpointAttemptId: options.checkpointAttemptId } : { restart: true }), allowEnvironmentChange: options.allowEnvironmentChange === true })
    return updated
  }
  async execution(id: string, executionId: string, committedOnly = false): Promise<Execution> {
    const run = this.store.get(id)
    if (!run.attempts.some(attempt => attempt.executionId === executionId)) throw new PipelineError(404, 'Execution does not belong to this run')
    const worker = this.workers.get(id); if (worker && !worker.isClosing) { const execution = committedOnly ? worker.receipt(executionId) : worker.get(executionId); if (execution) return execution }
    const ledger = await ScienceLedger.open(await this.directory(id))
    try { const definition = this.store.definition(run.definitionId); const execution = ledger.execution(executionId); if (!execution || execution.language !== definition.language) throw new PipelineError(404, 'Execution receipt missing'); return execution } finally { ledger.close() }
  }
  async artifact(id: string, executionId: string, artifactId: string): Promise<{ bytes: Buffer; mime: string }> {
    const execution = await this.execution(id, executionId); const artifact = execution.artifacts.find(artifact => artifact.id === artifactId)
    if (!artifact) throw new PipelineError(404, 'Pipeline artifact not found')
    return { bytes: await artifactBytes(await this.directory(id), artifact), mime: artifact.mime }
  }
  dispose(): Promise<void> { return this.disposing ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closing = true; for (const controller of this.controllers.values()) controller.abort(new Error('Host shutting down'))
    await Promise.allSettled([...this.workers.values()].map(worker => worker.dispose()))
    await Promise.allSettled(this.active.values()); this.workers.clear(); try { this.store.recover() } finally { this.store.close() }
  }
}
