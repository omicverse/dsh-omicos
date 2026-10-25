import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { readJson, writeJson } from './storage.js'
import { PROTOCOL_VERSION, type Execution, type Memory, type ScienceSnapshot, type Variable } from './types.js'

const workerPath = fileURLToPath(new URL('../../runtime/python_worker.py', import.meta.url))
const terminal = new Set(['succeeded', 'failed', 'canceled', 'interrupted'])
export class ScienceService extends EventEmitter {
  private child?: ChildProcess
  private generation?: string
  private executions: Execution[] = []
  private variables: Variable[] = []
  private memories: Memory[] = []
  private active?: Execution
  private queue: Execution[] = []
  private saving: Promise<void> = Promise.resolve()
  private closing = false
  private releaseLock?: () => Promise<void>
  private lockFailure?: string
  private cancelTimer?: ReturnType<typeof setTimeout>
  private constructor(readonly workspace: string, readonly python: string) { super() }

  static async open(workspace: string, python = 'python3'): Promise<ScienceService> {
    await mkdir(workspace, { recursive: true })
    const service = new ScienceService(await realpath(workspace), python)
    await mkdir(service.directory, { recursive: true, mode: 0o700 })
    service.releaseLock = await lockfile.lock(service.directory, { realpath: true, lockfilePath: join(service.directory, 'runtime.lock'), stale: 10000, update: 2000, retries: 0, onCompromised: error => {
      service.lockFailure = `Project runtime lock lost: ${error.message}`
      service.closing = true; service.child?.kill('SIGKILL'); service.emit('diagnostic', service.lockFailure)
    } })
    try {
    service.executions = await readJson<Execution[]>(join(service.directory, 'executions.json'), [])
    service.memories = await readJson<Memory[]>(join(service.directory, 'memories.json'), [])
    for (const job of service.executions) if (!terminal.has(job.state)) {
      job.state = 'interrupted'; job.endedAt = new Date().toISOString(); job.error = 'Host stopped; execution outcome is unknown. Inspect data before rerunning.'
    }
    await service.persist()
    return service
    } catch (error) { await service.releaseLock(); throw error }
  }
  private get directory(): string { return join(this.workspace, '.omicos-oss') }
  private persist(): Promise<void> {
    if (this.lockFailure) return Promise.reject(new Error(this.lockFailure))
    const snapshot = JSON.parse(JSON.stringify(this.executions)) as Execution[]
    const next = this.saving.then(() => writeJson(join(this.directory, 'executions.json'), snapshot))
    this.saving = next.catch(() => {})
    return next
  }
  snapshot(): ScienceSnapshot {
    return structuredClone({ protocol: PROTOCOL_VERSION, project: this.workspace,
      kernel: { state: this.active ? 'busy' : this.child ? 'ready' : 'cold', generation: this.generation },
      executions: this.executions, variables: this.variables, memories: this.memories })
  }
  get(id: string): Execution | undefined { return structuredClone(this.executions.find(job => job.id === id)) }
  async submit(code: string, operationId: string, sessionId: string): Promise<Execution> {
    if (this.closing) throw new Error('Scientific service is shutting down')
    if (!code.trim() || code.length > 200_000) throw new Error('Code must contain 1–200000 characters')
    if (!operationId || operationId.length > 200 || !sessionId || sessionId.length > 200) throw new Error('Valid operationId and sessionId are required')
    const existing = this.executions.find(job => job.operationId === operationId)
    if (existing) {
      if (existing.code !== code || existing.sessionId !== sessionId) throw new Error('Operation ID already belongs to another execution')
      return structuredClone(existing)
    }
    const job: Execution = { id: randomUUID(), operationId, sessionId, code, language: 'python', state: 'queued', createdAt: new Date().toISOString(), output: '', artifacts: [] }
    // Register before awaiting disk: concurrent retries see the same operation.
    this.executions.push(job)
    try { await this.persist() } catch (error) { this.executions.splice(this.executions.indexOf(job), 1); throw error }
    this.queue.push(job)
    this.emit('change')
    void this.pump().catch(error => this.failWorker(String(error)))
    return structuredClone(job)
  }
  private async start(): Promise<void> {
    if (this.child) return
    const child = spawn(this.python, ['-u', workerPath, this.workspace], { cwd: this.workspace, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], env: { ...process.env, MPLBACKEND: 'Agg' } })
    child.stdin?.on('error', error => { if (this.child === child) { this.child = undefined; this.failWorker(`Worker input failed: ${error.message}`); child.kill('SIGKILL') } })
    this.child = child; this.generation = randomUUID()
    const lines = createInterface({ input: child.stdio[3]! as NodeJS.ReadableStream })
    let startupError = ''
    child.stderr?.on('data', chunk => { startupError = (startupError + String(chunk)).slice(-8000) })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = undefined; this.variables = []; this.generation = undefined
      if (this.active) this.failWorker(startupError || 'Python worker exited; namespace lost, inspect partial side effects before retrying')
    })
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Python worker startup timed out')) }, 10_000)
      child.once('error', error => { clearTimeout(timer); if (this.child === child) this.child = undefined; fail(error) })
      child.once('exit', () => { clearTimeout(timer); fail(new Error(startupError || 'Python worker failed to start')) })
      lines.on('line', line => {
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready') { clearTimeout(timer); ok(); return }
          this.consume(message)
        } catch (error) { this.failWorker(`Invalid worker message: ${String(error)}`); child.kill('SIGKILL') }
      })
    })
  }
  private async pump(): Promise<void> {
    if (this.active || this.closing) return
    const next = this.queue.shift()
    if (!next) return
    this.active = next
    await this.start()
    if (next.state === 'canceled') { this.active = undefined; void this.pump(); return }
    next.state = 'running'; next.startedAt = new Date().toISOString(); next.kernelGeneration = this.generation
    await this.persist(); this.emit('change')
    this.child!.stdin!.write(JSON.stringify({ id: next.id, code: next.code }) + '\n')
  }
  private consume(message: { id: string; type: string; text?: string; error?: string; canceled?: boolean; variables?: Variable[]; artifacts?: Execution['artifacts'] }): void {
    const job = this.active
    if (!job || job.id !== message.id) return
    if (message.type === 'output') { job.output = (job.output + (message.text ?? '')).slice(-128_000); this.emit('change'); return }
    if (message.type !== 'done') return
    clearTimeout(this.cancelTimer)
    job.state = message.canceled ? 'canceled' : message.error ? 'failed' : 'succeeded'
    job.error = message.error || undefined; job.endedAt = new Date().toISOString(); job.artifacts = message.artifacts ?? []
    this.variables = message.variables ?? []; this.active = undefined
    void this.persist().then(() => { this.emit('change'); return this.pump() }).catch(error => this.emit('diagnostic', String(error)))
  }
  private failWorker(error: string): void {
    clearTimeout(this.cancelTimer)
    if (this.active) { this.active.state = 'interrupted'; this.active.error = error; this.active.endedAt = new Date().toISOString(); this.active = undefined }
    for (const job of this.queue) { job.state = 'interrupted'; job.error = 'Worker unavailable; submit a new operation after inspecting the environment'; job.endedAt = new Date().toISOString() }
    this.queue = []
    void this.persist().then(() => this.emit('change')).catch(error => this.emit('diagnostic', String(error)))
  }
  async cancel(id: string): Promise<void> {
    const job = this.executions.find(item => item.id === id)
    if (!job) throw new Error('Execution not found')
    if (terminal.has(job.state)) return
    if (job !== this.active || job.state === 'queued') {
      job.state = 'canceled'; job.endedAt = new Date().toISOString(); this.queue = this.queue.filter(item => item !== job)
      await this.persist(); this.emit('change'); return
    }
    this.child?.kill('SIGINT')
    const child = this.child
    this.cancelTimer = setTimeout(() => {
      if (this.active === job) { child?.kill('SIGKILL'); this.failWorker('Canceled by terminating unresponsive worker; namespace lost and partial changes may remain') }
    }, 3000)
  }
  async remember(id: string, text: string, source: string): Promise<void> {
    if (this.closing) throw new Error('Project is shutting down or its runtime lock was lost')
    if (!id || id.length > 200 || text.length > 20000 || !source || source.length > 2000) throw new Error('Memory requires bounded id, text and source')
    const next = this.memories.filter(memory => memory.id !== id)
    if (text) next.push({ id, text, source, updatedAt: new Date().toISOString() })
    await writeJson(join(this.directory, 'memories.json'), next)
    this.memories = next; this.emit('change')
  }
  notebook(): unknown {
    return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }, cells: this.executions.map((job, index) => ({
      id: job.id, cell_type: 'code', execution_count: job.startedAt ? index + 1 : null, source: job.code,
      metadata: { omicos: { state: job.state, invocation_id: job.id, kernel_generation: job.kernelGeneration, artifacts: job.artifacts } },
      outputs: [...(job.output ? [{ output_type: 'stream', name: 'stdout', text: job.output }] : []), ...(job.error ? [{ output_type: 'error', ename: job.state, evalue: job.error, traceback: job.error.split('\n') }] : [])],
    })) }
  }
  async dispose(): Promise<void> {
    this.closing = true
    clearTimeout(this.cancelTimer)
    this.failWorker('Host shutting down; execution outcome unknown')
    const child = this.child; this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() }); child.once('error', () => { clearTimeout(timer); resolve() }); child.kill('SIGTERM')
    })
    await this.saving
    const release = this.releaseLock; this.releaseLock = undefined
    if (release && !this.lockFailure) await release()
    this.removeAllListeners()
  }
}
