import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScienceLedger } from '../src/oss/ledger.js'
import { ScienceService } from '../src/oss/science.js'
import type { Execution } from '../src/oss/types.js'

async function settled(service: ScienceService, id: string): Promise<Execution> {
  const end = Date.now() + 12_000
  while (Date.now() < end) {
    const job = service.get(id)!
    if (!['queued', 'running'].includes(job.state)) return job
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Execution did not settle')
}
describe('public scientific runtime with real Python workers', () => {
  let path: string; const services: ScienceService[] = []
  beforeEach(async () => { path = await mkdtemp(join(tmpdir(), 'omicos-science-')) })
  afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await rm(path, { recursive: true, force: true }) })
  const open = async (workspace: string, python?: string) => { const service = await ScienceService.open(workspace, python); services.push(service); return service }
  it('shares a namespace across cells, captures final expression, and exports notebook without private Core', async () => {
    const service = await open(path)
    const first = await service.submit('value = 40\nprint("loaded")', 'one', 'session')
    const result = await settled(service, first.id)
    expect(result.state).toBe('succeeded')
    expect(result.environment?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.environment?.version).not.toBe('unknown')
    const second = await service.submit('value += 2\nvalue', 'two', 'session')
    expect((await settled(service, second.id)).output).toContain('42')
    expect(service.snapshot().variables.find(variable => variable.name === 'value')?.preview).toBe('42')
    const notebook = service.notebook() as any
    expect(notebook.nbformat).toBe(4)
    expect(notebook.cells).toHaveLength(2)
    expect(notebook.cells[1].metadata.omicos.kernel_generation).toBeTruthy()
  })
  it('deduplicates concurrent operations and rejects mismatched retries', async () => {
    const service = await open(path)
    const jobs = await Promise.all([service.submit('counter = 1', 'same', 'session'), service.submit('counter = 1', 'same', 'session')])
    expect(jobs[0].id).toBe(jobs[1].id)
    expect((await settled(service, jobs[0].id)).state).toBe('succeeded')
    await expect(service.submit('counter = 2', 'same', 'session')).rejects.toThrow('another execution')
  })
  it('does not confuse native stdout writes with control messages; survives Python errors', async () => {
    const service = await open(path)
    const first = await service.submit('import os\nos.write(1, b"not-json\\n")\nprint("captured")', 'native', 'session')
    expect((await settled(service, first.id)).output).toContain('captured')
    const bad = await service.submit('1/0', 'bad', 'session')
    expect((await settled(service, bad.id)).state).toBe('failed')
    const good = await service.submit('print("alive")', 'good', 'session')
    expect((await settled(service, good.id)).state).toBe('succeeded')
  })
  it('cancels actual execution and keeps the kernel available after KeyboardInterrupt', async () => {
    const service = await open(path)
    const job = await service.submit('import time\ntime.sleep(30)', 'slow', 'session')
    while (service.get(job.id)?.state !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    await new Promise(resolve => setTimeout(resolve, 100))
    await service.cancel(job.id)
    expect((await settled(service, job.id)).state).toBe('canceled')
    const next = await service.submit('print("resumed")', 'next', 'session')
    expect((await settled(service, next.id)).output).toContain('resumed')
  })
  it('isolates different projects and preserves history and sourced memory after reopen', async () => {
    const service = await open(path)
    const job = await service.submit('secret = 17', 'first', 'session')
    await settled(service, job.id)
    await service.remember('reference', 'Use GRCh38', 'user confirmed')
    const other = await open(join(path, 'other'))
    const check = await other.submit('print("secret" in globals())', 'check', 'session')
    expect((await settled(other, check.id)).output).toContain('False')
    await service.dispose()
    const reopened = await open(path)
    expect(reopened.snapshot().executions).toHaveLength(1)
    expect(reopened.snapshot().variables).toEqual([])
    expect(reopened.snapshot().memories[0].source).toBe('user confirmed')
  })
  it('marks unfinished historical executions interrupted and does not rerun them', async () => {
    const service = await open(path)
    const job = await service.submit('print("once")', 'first', 'session')
    await settled(service, job.id); await service.dispose()
    const ledger = await ScienceLedger.open(path)
    const records = ledger.executions('python'); records[0].state = 'running'
    ledger.saveExecutions('python', records); ledger.close()
    const reopened = await open(path)
    expect(reopened.snapshot().executions[0].state).toBe('interrupted')
    expect(reopened.snapshot().kernel.state).toBe('cold')
  })
  it('refuses concurrent owners of the same project and releases ownership after shutdown', async () => {
    const service = await open(path)
    await expect(ScienceService.open(path)).rejects.toThrow(/lock/i)
    await service.dispose()
    const reopened = await open(path)
    expect(reopened.snapshot().kernel.state).toBe('cold')
  })
  it('settles interrupted when the terminal receipt cannot be committed, rather than hanging a tool waiter', async () => {
    const service = await open(path)
    const original = ScienceLedger.prototype.saveExecutions
    let injected = false
    const spy = vi.spyOn(ScienceLedger.prototype, 'saveExecutions').mockImplementation(function (language, records) {
      if (!injected && records.some(record => record.state === 'succeeded')) { injected = true; throw new Error('Injected storage failure') }
      return original.call(this, language, records)
    })
    try {
      const job = await service.submit('print(42)', 'storage-failure', 'session')
      const result = await settled(service, job.id)
      expect(injected).toBe(true)
      expect(result.state).toBe('interrupted')
      expect(result.error).toContain('Injected storage failure')
    } finally { spy.mockRestore() }
  })
  it('reports missing interpreters as interrupted without hanging queued work', async () => {
    const service = await open(path, join(path, 'no-python'))
    const job = await service.submit('1', 'missing', 'session')
    expect((await settled(service, job.id)).state).toBe('interrupted')
  })
})

it('refuses a lost Pipeline namespace without sending code or starting a replacement worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-generation-'))
  const python = process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3'
  let service = await ScienceService.open(directory, python)
  try {
    await Promise.all([service.prepare(), service.prepare()])
    const generation = service.snapshot().kernel.generation!
    await service.dispose(); service = await ScienceService.open(directory, python)
    const job = await service.submit('open("should-never-run", "w").write("bad")', 'expected-old-namespace', 'pipeline', generation)
    for (let count = 0; count < 100 && (service.get(job.id)?.state !== 'interrupted' || service.snapshot().kernel.state === 'busy'); count++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(job.id)?.state).toBe('interrupted')
    expect(service.get(job.id)?.error).toContain('Code was not executed')
    expect(service.snapshot().kernel.state).toBe('cold')
    await expect(readFile(join(directory, 'should-never-run'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})
