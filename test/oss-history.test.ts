import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScienceLedger } from '../src/oss/ledger.js'
import { ScienceService } from '../src/oss/science.js'
import type { Execution } from '../src/oss/types.js'
let directory: string; let service: ScienceService | undefined
const job = (index: number): Execution => ({ id: `history-${index}`, operationId: `operation-${index}`, sessionId: 'research', language: 'python', state: 'succeeded', createdAt: '2026-10-25T00:00:00Z', code: `print(${index})${index === 1 ? ' # HISTORICAL_NEEDLE' : ''}`, output: String(index), artifacts: [] })
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-history-')) })
afterEach(async () => { await service?.dispose(); service = undefined; await rm(directory, { recursive: true, force: true }) })
const seed = async (jobs: Execution[]) => { const ledger = await ScienceLedger.open(directory); try { ledger.saveExecutions('python', jobs) } finally { ledger.close() } }
describe('bounded execution windows with complete durable history', () => {
  it('recovers older unfinished work and keeps archived invocation deduplication and full export', async () => {
    const records = Array.from({ length: 250 }, (_, index) => job(index)); records[2].state = 'queued'; records[3].state = 'running'
    await seed(records); service = await ScienceService.open(directory, '/never-start-for-history')
    const snapshot = service.snapshot(); expect(snapshot.executions).toHaveLength(100); expect(snapshot.executions[0].id).toBe('history-150'); expect(snapshot.executionWindow).toMatchObject({ total: 250, shown: 100, active: 0, hasMore: true })
    expect(service.get('history-2')?.state).toBe('interrupted'); expect(service.get('history-3')?.state).toBe('interrupted')
    const replay = await service.submit(records[1].code, records[1].operationId, records[1].sessionId); expect(replay.id).toBe(records[1].id)
    await expect(service.submit('print("changed")', records[1].operationId, 'research')).rejects.toThrow(/another execution/)
    expect((await service.submit(records[2].code, records[2].operationId, 'research')).state).toBe('interrupted')
    await service.cancel(records[1].id); expect(service.get(records[1].id)?.state).toBe('succeeded')
    expect(service.snapshot().kernel.state).toBe('cold')
    const book = service.notebook() as any; expect(book.cells).toHaveLength(250); expect(book.cells[1].source).toContain('HISTORICAL_NEEDLE'); expect(book.cells[2].metadata.omicos.state).toBe('interrupted')
    expect(service.history({ state: 'interrupted' }).entries.map(entry => entry.id)).toEqual(['history-3', 'history-2'])
  })
  it('pages bounded summaries without returning full code/output and searches archives without a kernel', async () => {
    const records = Array.from({ length: 121 }, (_, index) => ({ ...job(index), output: 'x'.repeat(5000), ...(index === 20 ? { code: '#' + 'y'.repeat(10000) } : {}) }))
    await seed(records)
    const ledger = await ScienceLedger.open(directory)
    try { ledger.saveExecutions('r', [{ ...job(0), id: 'r-archive', operationId: 'operation-0', language: 'r', state: 'running', code: 'print(123)', output: '123' }]) } finally { ledger.close() }
    service = await ScienceService.open(directory, '/never-start-for-pagination')
    expect(service.historyFor('r', { state: 'running' }).entries.map(entry => entry.id)).toEqual(['r-archive'])
    expect(service.get('r-archive')).toBeUndefined(); expect(service.kernelState().state).toBe('cold')
    const first = service.history(); const second = service.history({ before: first.next }); const last = service.history({ before: second.next })
    expect(first.entries).toHaveLength(50); expect(second.entries).toHaveLength(50); expect(last.entries).toHaveLength(21)
    const all = [...first.entries, ...second.entries, ...last.entries]; expect(new Set(all.map(entry => entry.id)).size).toBe(121)
    expect(all.every(entry => entry.outputTail.length <= 1000 && entry.codePreview.length <= 240)).toBe(true)
    expect(all.find(entry => entry.id === 'history-20')).not.toHaveProperty('code')
    expect(service.history({ search: 'HISTORICAL_NEEDLE' }).entries.map(entry => entry.id)).toEqual(['history-1'])
    expect(service.get('history-20')?.code).toHaveLength(10001)
    expect(() => service!.history({ before: -1 })).toThrow(/cursor/); expect(() => service!.history({ state: 'unknown' })).toThrow(/filter/)
  })
  it('keeps more than 100 actual queued executions, then deduplicates evicted work without incrementing again', async () => {
    service = await ScienceService.open(directory, process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3')
    const code = 'counter = globals().get("counter", 0) + 1\nprint(counter)'
    const jobs = await Promise.all(Array.from({ length: 110 }, (_, index) => service!.submit(code, `live-${index}`, 'research')))
    for (let count = 0; count < 1000 && !['succeeded', 'failed', 'interrupted'].includes(service.get(jobs.at(-1)!.id)!.state); count++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(jobs.at(-1)!.id)?.output.trim()).toBe('110')
    expect(service.get(jobs[0].id)?.output.trim()).toBe('1')
    expect((await service.submit(code, 'live-0', 'research')).id).toBe(jobs[0].id)
    expect(service.snapshot().executions).toHaveLength(100); expect(service.snapshot().executionWindow?.total).toBe(110)
    const check = await service.submit('print(counter)', 'verify-no-rerun', 'research')
    for (let count = 0; count < 100 && service.get(check.id)?.state !== 'succeeded'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(check.id)?.output.trim()).toBe('110')
    expect([...service.notebookCells()]).toHaveLength(111)
  }, 30000)
})
