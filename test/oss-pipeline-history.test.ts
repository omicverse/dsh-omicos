import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PipelineStore } from '../src/oss/pipeline-store.js'
import { OssRuntime } from '../src/oss/runtime.js'
let directory: string; let store: PipelineStore
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-pipeline-history-')); store = await PipelineStore.open(directory) })
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
const definition = (index: number) => ({ title: index === 0 ? 'Archived method needle' : `Method ${index}`, language: 'python', steps: [{ id: 'step', code: `print(${index})` }] })
describe('complete paginated Pipeline collections', () => {
  it('pages all definitions/runs using bounded summaries while exact immutable IDs remain readable', () => {
    const definitions = Array.from({ length: 121 }, (_, index) => store.define(definition(index)))
    const runs = Array.from({ length: 130 }, (_, index) => { const run = store.create(definitions[index % definitions.length].id, `history-${index}`).run; return store.update(run.id, run.revision, 'fixture/completed', draft => { draft.state = 'succeeded'; if (index === 129) { draft.reason = 'x'.repeat(8000); draft.attempts = Array.from({ length: 120 }, (_, index) => ({ id: `attempt-${index}`, operationId: `attempt-${index}`, step: 0, kind: 'step', state: 'succeeded', outputTail: 'x'.repeat(8000) })) } }) })
    const first = store.definitionPage(); const second = store.definitionPage(first.next); const third = store.definitionPage(second.next)
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([50,50,21]); expect(first.total).toBe(121)
    expect(new Set([...first.entries,...second.entries,...third.entries].map(item => item.id)).size).toBe(121)
    expect(store.definitionPage(undefined, 'archived METHOD').entries[0].id).toBe(definitions[0].id)
    expect(store.definition(definitions[0].id).steps[0].code).toBe('print(0)')
    const page = store.runPage(); const next = store.runPage(page.next); const last = store.runPage(next.next)
    expect([page.entries.length,next.entries.length,last.entries.length]).toEqual([50,50,30])
    expect(new Set([...page.entries,...next.entries,...last.entries].map(item => item.id)).size).toBe(130)
    expect(page.entries[0].attempts).toBe(120); expect(page.entries[0].reason).toHaveLength(2000)
    expect(page.entries[0]).not.toHaveProperty('recoveries'); expect(JSON.stringify(page)).not.toContain('outputTail')
    expect(store.runPage(undefined, runs[0].id).entries[0].id).toBe(runs[0].id)
    expect(store.runPage(undefined, 'history-0', 'failed').entries).toEqual([])
    expect(store.get(runs[129].id).attempts[0].outputTail).toHaveLength(8000)
    expect(() => store.definitionPage(-1)).toThrow(/cursor/); expect(() => store.runPage(undefined,'','unknown')).toThrow(/state/)
  })
  it('recovers old unfinished runs outside the first page without launching or replaying them', async () => {
    const pinned = store.define(definition(0)); const old = store.create(pinned.id, 'old-unfinished').run
    store.update(old.id, old.revision, 'fixture/waiting', draft => { draft.state = 'waiting' })
    for (let index = 0; index < 130; index++) { const run = store.create(pinned.id, `completed-${index}`).run; store.update(run.id, run.revision, 'fixture/completed', draft => { draft.state = 'succeeded' }) }
    const runtime = await OssRuntime.open({ stateDir: join(directory, 'state'), python: '/must-not-run-for-history', rscript: '/must-not-run-for-history' })
    try {
      const pipelines = await runtime.pipelines(directory)
      expect(pipelines.get(old.id).state).toBe('interrupted'); expect(pipelines.list().runs).toHaveLength(50)
      expect(pipelines.list({ state: 'interrupted' }).runs.map(run => run.id)).toEqual([old.id])
      expect(pipelines.start(pinned.id, 'old-unfinished').id).toBe(old.id)
      expect(pipelines.list().runPage.total).toBe(131)
      expect((await runtime.project(directory)).kernelState().state).toBe('cold')
    } finally { await runtime.dispose() }
  })
})
