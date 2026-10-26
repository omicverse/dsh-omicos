import type { MemoryAccess } from './memory-types.js'
import { NotebookStore } from './notebooks.js'
import { workerEnvironment } from './worker-environment.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'
import { mkdir, realpath, readFile, stat } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { ScienceLedger } from './ledger.js'
import { PROTOCOL_VERSION, type Artifact, type Execution, type KernelEnvironment, type ScienceSnapshot, type Variable } from './types.js'

const supervisor = fileURLToPath(new URL('../../runtime/worker_watchdog.cjs', import.meta.url))
const workerPaths = { python: fileURLToPath(new URL('../../runtime/python_worker.py', import.meta.url)), r: fileURLToPath(new URL('../../runtime/r_worker.R', import.meta.url)) }
const terminal = new Set(['succeeded', 'failed', 'canceled', 'interrupted'])
export class ScienceService extends EventEmitter {
  private child?: ChildProcess
  private terminatedFamilies = new WeakSet<ChildProcess>()
  private starting?: Promise<void>
  private disposing?: Promise<void>
  private generation?: string
  private environment?: KernelEnvironment
  private executions: Execution[] = []
  private dispatchChecks = new Map<string, (dispatch: boolean) => void>()
  private dirtyExecutions = new Map<string, number>()
  private writeSequence = 0
  private variables: Variable[] = []
  private ledger!: ScienceLedger
  private notebookStore?: NotebookStore
  get notebooks(): NotebookStore { if (!this.notebookStore) throw new Error('Notebook documents are owned by the parent project service'); return this.notebookStore }
  private lastOutputPersist = 0
  private active?: Execution
  private finishing?: Execution
  private queue: Execution[] = []
  private saving: Promise<void> = Promise.resolve()
  private closing = false
  private releaseLock?: () => Promise<void>
  private lockFailure?: string
  private cancelTimer?: ReturnType<typeof setTimeout>
  private isolatedPython = false
  get usesIsolatedPython(): boolean { return this.isolatedPython }
  private executionBlock?: string
  get interpreter(): string { return this.interpreterPath }
  get executionUnavailable(): string | undefined { return this.executionBlock }
  configureColdInterpreter(interpreter: string, unavailable?: string, isolatedPython = false): void {
    if (this.child || this.starting || this.active || this.finishing || this.queue.length) throw new Error('Cannot change the interpreter of a live scientific kernel')
    this.interpreterPath = interpreter; this.executionBlock = unavailable; this.isolatedPython = isolatedPython
  }
  private constructor(readonly workspace: string, private interpreterPath: string, readonly language: 'python' | 'r', private envNames: readonly string[]) { super() }

  static async open(workspace: string, python = 'python3', language: 'python' | 'r' = 'python', envNames: readonly string[] = []): Promise<ScienceService> {
    await mkdir(workspace, { recursive: true })
    const service = new ScienceService(await realpath(workspace), python, language, envNames)
    const rootDirectory = join(service.workspace, '.omicos-oss')
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
    if (await realpath(rootDirectory) !== rootDirectory) throw new Error('Scientific runtime directory cannot be a symbolic link')
    await mkdir(service.directory, { recursive: true, mode: 0o700 })
    if (await realpath(service.directory) !== service.directory) throw new Error('Scientific runtime directory cannot be a symbolic link')
    service.releaseLock = await lockfile.lock(service.directory, { realpath: true, lockfilePath: join(service.directory, 'runtime.lock'), stale: 10000, update: 2000, retries: 0, onCompromised: error => {
      service.lockFailure = `Project runtime lock lost: ${error.message}`
      service.closing = true; service.child && service.signalWorker(service.child, 'SIGKILL'); service.emit('diagnostic', service.lockFailure)
    } })
    try {
    service.ledger = await ScienceLedger.open(service.workspace)
    if (language === 'python') service.notebookStore = await NotebookStore.open(service.workspace)
    service.ledger.recoverExecutions(service.language)
    service.executions = service.ledger.recentExecutions(service.language)
    return service
    } catch (error) { service.ledger?.close(); await service.releaseLock(); throw error }
  }
  get isClosing(): boolean { return this.closing }
  get python(): string { return this.interpreter }
  private get directory(): string { return this.language === 'python' ? join(this.workspace, '.omicos-oss') : join(this.workspace, '.omicos-oss', 'r') }
  private persist(records: readonly Execution[] = this.executions): Promise<void> {
    if (this.lockFailure) return Promise.reject(new Error(this.lockFailure))
    const snapshot = JSON.parse(JSON.stringify(records)) as Execution[]; const sequence = ++this.writeSequence
    for (const job of records) this.dirtyExecutions.set(job.id, sequence)
    const next = this.saving.then(() => {
      this.ledger.saveExecutions(this.language, snapshot)
      for (const job of records) if (this.dirtyExecutions.get(job.id) === sequence) this.dirtyExecutions.delete(job.id)
      this.retainRecent()
    })
    this.saving = next.catch(() => {})
    return next
  }
  private retainRecent(): void {
    const recent = new Set(this.executions.slice(-100).map(job => job.id))
    this.executions = this.executions.filter(job => recent.has(job.id) || !terminal.has(job.state) || this.dirtyExecutions.has(job.id) || this.active?.id === job.id || this.finishing?.id === job.id)
    for (const id of this.dispatchChecks.keys()) { const job = this.executions.find(item => item.id === id); if (!job || terminal.has(job.state)) this.dispatchChecks.delete(id) }
  }
  history(query: { before?: number; state?: string; search?: string } = {}) { return this.ledger.executionHistory(this.language, query) }
  historyFor(language: 'python' | 'r', query: { before?: number; state?: string; search?: string } = {}) { return this.ledger.executionHistory(language, query) }
  artifact(id: string, executionId?: string): Artifact | undefined { if (executionId) return structuredClone(this.get(executionId)?.artifacts.find(item => item.id === id)); const persisted = this.ledger.artifact(this.language, id); if (persisted) return persisted; const matches = this.executions.flatMap(job => job.artifacts).filter(artifact => artifact.id === id); if (matches.length > 1) throw new Error('Artifact identity is ambiguous'); return structuredClone(matches[0]) }
  memories(sessionId?: string) { return this.ledger.memories(sessionId) }
  kernelState(): ScienceSnapshot['kernel'] { return structuredClone({ state: this.active ? 'busy' : this.child ? 'ready' : 'cold', generation: this.generation, environment: this.environment }) }
  receipt(id: string): Execution | undefined { return this.ledger.execution(id) }
  figureCandidates(cursor?: string) { return this.ledger.figureCandidates(cursor) }
  get memory() { return this.ledger.memory }
  snapshot(sessionId?: string): ScienceSnapshot {
    const executions = this.executions.slice(-100); const total = Math.max(this.ledger.executionCount(this.language), this.executions.length)
    return structuredClone({ protocol: PROTOCOL_VERSION, project: this.workspace, eventCursor: this.eventCursor,
      kernel: this.kernelState(),
      executionWindow: { shown: executions.length, total, active: this.executions.filter(job => !terminal.has(job.state)).length, hasMore: total > executions.length }, executions, variables: this.variables, memories: this.memories(sessionId) })
  }
  get(id: string): Execution | undefined { const job = this.executions.find(job => job.id === id) || this.ledger.execution(id); return job?.language === this.language ? structuredClone(job) : undefined }
  async submit(code: string, operationId: string, sessionId: string, expectedKernelGeneration?: string, beforeDispatch?: (dispatch: boolean) => void): Promise<Execution> {
    if (this.closing) throw new Error('Scientific service is shutting down')
    if (!code.trim() || code.length > 200_000) throw new Error('Code must contain 1–200000 characters')
    if (!operationId || operationId.length > 200 || !sessionId || sessionId.length > 200) throw new Error('Valid operationId and sessionId are required')
    const existing = this.executions.find(job => job.operationId === operationId) || this.ledger.byOperation(this.language, operationId)
    if (existing) {
      if (existing.code !== code || existing.sessionId !== sessionId || existing.expectedKernelGeneration !== expectedKernelGeneration) throw new Error('Operation ID already belongs to another execution')
      return structuredClone(existing)
    }
    if (this.executionBlock) throw new Error(this.executionBlock)
    const job: Execution = { id: randomUUID(), operationId, sessionId, code, language: this.language, state: 'queued', createdAt: new Date().toISOString(), output: '', artifacts: [], ...(expectedKernelGeneration ? { expectedKernelGeneration } : {}) }
    // Register before awaiting disk: concurrent retries see the same operation.
    this.executions.push(job)
    if (beforeDispatch) this.dispatchChecks.set(job.id, beforeDispatch)
    try { await this.persist([job]) } catch (error) { this.executions.splice(this.executions.indexOf(job), 1); this.dirtyExecutions.delete(job.id); this.dispatchChecks.delete(job.id); throw error }
    this.queue.push(job)
    this.emit('change')
    void this.pump().catch(error => this.failWorker(String(error)))
    return structuredClone(job)
  }
  async prepare(): Promise<KernelEnvironment> {
    if (this.executionBlock) throw new Error(this.executionBlock)
    if (this.closing) throw new Error('Scientific service is shutting down')
    await this.start()
    if (!this.environment) throw new Error('Scientific worker did not report its environment')
    return structuredClone(this.environment)
  }
  private signalWorker(child: ChildProcess, signal: NodeJS.Signals): void {
    // A successful SIGKILL can precede Node's exit event. Do not target that
    // dying process group again during disposal (or after a PID is recycled).
    if (child.exitCode !== null || child.signalCode !== null || this.terminatedFamilies.has(child)) return
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal)
      if (signal === 'SIGKILL') this.terminatedFamilies.add(child)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; this.terminatedFamilies.add(child) }
  }
  private start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.child) return Promise.resolve()
    const pending = this.startWorker(); this.starting = pending
    void pending.finally(() => { if (this.starting === pending) this.starting = undefined }).catch(() => {})
    return pending
  }
  private async startWorker(): Promise<void> {
    const args = this.language === 'python' ? [...(this.isolatedPython ? ['-I'] : []), '-B', '-u', workerPaths.python, this.workspace] : ['--vanilla', workerPaths.r, this.workspace, process.execPath, fileURLToPath(new URL('../../runtime/r_protocol_relay.cjs', import.meta.url))]
    const child = spawn(process.execPath, [supervisor, this.interpreter, ...args], { cwd: this.workspace, detached: process.platform !== 'win32', stdio: ['pipe', this.language === 'python' ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'], env: { ...workerEnvironment(process.env, this.envNames), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } })
    child.stdin?.on('error', error => { if (this.child === child) { this.child = undefined; this.failWorker(`Worker input failed: ${error.message}`); this.signalWorker(child, 'SIGKILL') } })
    this.child = child; this.generation = randomUUID()
    const lines = createInterface({ input: child.stdio[3]! as NodeJS.ReadableStream })
    let startupError = ''
    child.stderr?.on('data', chunk => { startupError = (startupError + String(chunk)).slice(-8000); if (this.language === 'r' && this.active?.state === 'running') void this.consume({ id: this.active.id, type: 'output', text: String(chunk) }) })
    child.stdout?.on('data', chunk => { if (this.active) void this.consume({ id: this.active.id, type: 'output', text: String(chunk) }) })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = undefined; this.variables = []; this.generation = undefined; this.environment = undefined
      if (this.active && this.finishing !== this.active && !terminal.has(this.active.state)) this.failWorker(startupError || 'Scientific worker exited; namespace lost, inspect partial side effects before retrying')
    })
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => { this.signalWorker(child, 'SIGKILL'); fail(new Error('Scientific worker startup timed out')) }, 10_000)
      child.once('error', error => { clearTimeout(timer); if (this.child === child) this.child = undefined; fail(error) })
      child.once('exit', () => { clearTimeout(timer); fail(new Error(startupError || 'Scientific worker failed to start')) })
      lines.on('line', line => {
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready') {
            const reported = message.environment || {}
            const metadata = { language: this.language, version: typeof reported.version === 'string' ? reported.version : 'unknown', executable: typeof reported.executable === 'string' ? reported.executable : this.interpreter,
              platform: typeof reported.platform === 'string' ? reported.platform : undefined, ...(reported.isolated === true ? { isolated: true } : {}),
              packages: Object.fromEntries(Object.entries(reported.packages || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => [name, typeof version === 'string' ? version : null])) }
            this.environment = { ...metadata, fingerprint: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') }
            clearTimeout(timer); ok(); return
          }
          void this.consume(message).catch(error => { this.failWorker(`Worker completion failed: ${String(error)}`, true); this.signalWorker(child, 'SIGKILL') })
        } catch (error) { this.failWorker(`Invalid worker message: ${String(error)}`); this.signalWorker(child, 'SIGKILL') }
      })
    })
  }
  private checkDispatch(job: Execution, dispatch = false): void { try { this.dispatchChecks.get(job.id)?.(dispatch) } catch (error) { throw new Error(`Execution pre-dispatch policy rejected; code was not executed. ${String(error)}`) } }
  private async pump(): Promise<void> {
    if (this.active || this.closing) return
    const next = this.queue.shift()
    if (!next) return
    this.active = next
    if (next.expectedKernelGeneration && (!this.child || this.generation !== next.expectedKernelGeneration)) {
      next.state = 'interrupted'; next.endedAt = new Date().toISOString(); next.error = 'Expected kernel generation is unavailable; restore a checkpoint or explicitly restart. Code was not executed.'
      await this.persist([next]); this.active = undefined; this.retainRecent(); this.emit('change'); await this.pump(); return
    }
    this.checkDispatch(next)
    await this.start()
    this.checkDispatch(next)
    if (next.state === 'canceled') { this.active = undefined; this.retainRecent(); void this.pump(); return }
    if (next.expectedKernelGeneration && this.generation !== next.expectedKernelGeneration) throw new Error('Kernel generation changed before execution; code was not sent')
    next.state = 'running'; next.startedAt = new Date().toISOString(); next.kernelGeneration = this.generation; next.environment = structuredClone(this.environment)
    await this.persist([next]); this.emit('change')
    this.checkDispatch(next, true)
    this.child!.stdin!.write(JSON.stringify({ id: next.id, code: next.code }) + '\n')
  }
  private async consume(message: { id: string; type: string; text?: string; error?: string; canceled?: boolean; variables?: Variable[]; artifacts?: Execution['artifacts'] }): Promise<void> {
    const job = this.active
    if (!job || job.id !== message.id) return
    if (message.type === 'output') {
      job.output = (job.output + (message.text ?? '')).slice(-128_000)
      if (Date.now() - this.lastOutputPersist > 500) { this.lastOutputPersist = Date.now(); void this.persist([job]).catch(error => this.emit('diagnostic', String(error))) }
      this.emit('change'); return
    }
    if (message.type !== 'done' || this.finishing === job) return
    this.finishing = job
    const generation = this.generation
    clearTimeout(this.cancelTimer)
    let outcome: Execution['state'] = message.canceled ? 'canceled' : message.error ? 'failed' : 'succeeded'
    job.error = message.error || undefined; job.endedAt = new Date().toISOString()
    const artifacts = message.artifacts ?? []
    job.artifacts = []
    for (const artifact of artifacts) {
      const path = await realpath(join(this.workspace, artifact.path))
      if (!path.startsWith(this.workspace + sep) || (await stat(path)).size > 32 * 1024 * 1024) { job.error = 'Generated artifact is outside the workspace or exceeds 32 MiB'; outcome = 'failed'; continue }
      const bytes = await readFile(path)
      job.artifacts.push({ ...artifact, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
    }
    if (this.active !== job || this.closing) return
    job.state = outcome
    this.variables = this.generation === generation ? message.variables ?? [] : []
    await this.persist([job])
    this.active = undefined; this.finishing = undefined; this.retainRecent()
    this.emit('change'); await this.pump()
  }
  private failWorker(error: string, forceUnknown = false): void {
    this.finishing = undefined
    clearTimeout(this.cancelTimer)
    const changed: Execution[] = []
    if (this.active && (forceUnknown || !terminal.has(this.active.state))) {
      this.active.state = 'interrupted'; this.active.error = error; this.active.endedAt = new Date().toISOString(); changed.push(this.active)
    }
    this.active = undefined
    for (const job of this.queue) { job.state = 'interrupted'; job.error = 'Worker unavailable; submit a new operation after inspecting the environment'; job.endedAt = new Date().toISOString(); changed.push(job) }
    this.queue = []
    // Waiters must settle even when the ledger itself is unavailable; never claim durable success.
    const settled = this.persist(changed).catch(error => { this.emit('diagnostic', String(error)) }).then(() => { this.emit('change') })
    this.saving = settled.catch(error => { this.emit('diagnostic', String(error)) })
  }
  async cancel(id: string): Promise<void> {
    const job = this.executions.find(item => item.id === id)
    if (!job) { const archived = this.get(id); if (archived && terminal.has(archived.state)) return; throw new Error('Execution is not owned by this live kernel; inspect its receipt before recovery') }
    if (terminal.has(job.state) || this.finishing === job) return
    if (job !== this.active || job.state === 'queued') {
      job.state = 'canceled'; job.endedAt = new Date().toISOString(); this.queue = this.queue.filter(item => item !== job)
      await this.persist([job]); this.emit('change'); return
    }
    this.child && this.signalWorker(this.child, 'SIGINT')
    const child = this.child
    this.cancelTimer = setTimeout(() => {
      if (this.active === job) { child && this.signalWorker(child, 'SIGKILL'); this.failWorker('Canceled by terminating unresponsive worker; namespace lost and partial changes may remain') }
    }, 3000)
  }
  async remember(id: string, text: string, source: string, access?: MemoryAccess): Promise<void> {
    if (this.closing) throw new Error('Project is shutting down or its runtime lock was lost')
    if (!id || id.length > 200 || text.length > 20000 || !source || source.length > 2000) throw new Error('Memory requires bounded id, text and source')
    this.ledger.remember(id, text, source, access)
    this.emit('change')
  }
  events(after = 0, limit = 200) { return this.ledger.events(after, limit) }
  get eventCursor(): number { return this.ledger.cursor }

  notebookHeader() { return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: this.language === 'r' ? 'R' : 'Python 3', language: this.language, name: this.language === 'r' ? 'ir' : 'python3' } } } }
  *notebookCells() {
    const pending = new Map(this.executions.map(job => [job.id, job])); let index = 0
    const cell = (job: Execution) => { const position = ++index; return { id: job.id, cell_type: 'code', execution_count: job.startedAt ? position : null, source: job.code,
      metadata: { omicos: { state: job.state, invocation_id: job.id, kernel_generation: job.kernelGeneration, environment: job.environment, artifacts: job.artifacts } },
      outputs: [...(job.output ? [{ output_type: 'stream', name: 'stdout', text: job.output }] : []), ...(job.error ? [{ output_type: 'error', ename: job.state, evalue: job.error, traceback: job.error.split('\n') }] : [])] } }
    for (const archived of this.ledger.scanExecutions(this.language)) { const job = pending.get(archived.id) || archived; pending.delete(archived.id); yield cell(job) }
    for (const job of pending.values()) yield cell(job)
  }
  notebook(): unknown { return { ...this.notebookHeader(), cells: [...this.notebookCells()] } }
  dispose(): Promise<void> { return this.disposing ??= this.disposeWorker() }
  private async disposeWorker(): Promise<void> {
    if (this.closing && !this.releaseLock) return
    this.closing = true
    this.emit('shutdown')
    clearTimeout(this.cancelTimer)
    this.failWorker('Host shutting down; execution outcome unknown')
    const child = this.child; this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.signalWorker(child, 'SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() }); child.once('error', () => { clearTimeout(timer); resolve() }); this.signalWorker(child, 'SIGTERM')
    })
    await this.starting?.catch(() => {})
    await this.notebookStore?.dispose()
    await this.saving
    this.ledger.close()
    const release = this.releaseLock; this.releaseLock = undefined
    if (release && !this.lockFailure) await release()
    this.dispatchChecks.clear()
    this.removeAllListeners()
  }
}
