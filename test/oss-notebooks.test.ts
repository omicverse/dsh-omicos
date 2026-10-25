import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NotebookStore } from '../src/oss/notebooks.js'
import { ScienceService } from '../src/oss/science.js'
import type { Execution } from '../src/oss/types.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-notebook-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
describe('persistent editable Notebooks and immutable execution links', () => {
  it('imports source without execution, preserves rich outputs as unverified and prevents language confusion', async () => {
    const store = await NotebookStore.open(directory)
    const imported = { nbformat: 4, metadata: { kernelspec: { language: 'python' }, custom: 'preserved' }, cells: [{ cell_type: 'code', source: ['print(', '42)'], outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>alert(1)</script>' }, metadata: {} }], metadata: { tags: ['important'] } }, { cell_type: 'markdown', source: '# Research notes', metadata: {}, attachments: { 'plot.png': { 'image/png': 'aGVsbG8=' } } }] }
    await expect(store.create('Wrong language', 'r', imported)).rejects.toThrow(/内核/)
    const document = await store.create('Analysis', 'python', imported)
    expect(document.cells[0].source).toBe('print(42)')
    expect(document.cells[0].runs).toEqual([])
    const exported = store.export(document.id, () => { throw new Error('Imported sources must not pretend to be runtime executions') }) as any
    expect(exported.cells[0].outputs).toEqual(imported.cells[0].outputs)
    expect(exported.cells[0].metadata.omicos.imported_outputs_unverified).toBe(true)
    expect(exported.cells[1].attachments).toEqual(imported.cells[1].attachments)
    expect(exported.metadata.custom).toBe('preserved')
    const edited = await store.save(document.id, document.revision, 'Edited', document.cells.map(cell => ({ ...cell, source: cell.source + '\n' })))
    expect(edited.cells[0].importedOutputs).toBeUndefined()
    const restored = await NotebookStore.open(directory)
    expect(restored.get(document.id)).toEqual(edited)
    await expect(restored.save(document.id, 1, 'Stale', document.cells)).rejects.toThrow(/其他窗口/)
    expect(restored.get(document.id).title).toBe('Edited')
  })
  it('serializes concurrent edits and rejects duplicate cells, oversized files and unsupported formats', async () => {
    const store = await NotebookStore.open(directory)
    const document = await store.create('one', 'python')
    const results = await Promise.allSettled([store.save(document.id, 1, 'A', document.cells), store.save(document.id, 1, 'B', document.cells)])
    expect(results.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    const current = store.get(document.id)
    await expect(store.save(document.id, current.revision, 'dup', [current.cells[0], current.cells[0]])).rejects.toThrow(/单元列表/)
    await expect(store.create('v3', 'python', { nbformat: 3, cells: [] })).rejects.toThrow(/nbformat/)
    await expect(store.create('huge', 'python', { data: 'a'.repeat(2000001) })).rejects.toThrow(/2 MB/)
  })
  it('uses the actual shared Python kernel, deduplicates retry and separates edited source from historical output', async () => {
    const science = await ScienceService.open(directory, process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3')
    try {
      const store = science.notebooks
      const document = await store.create('Shared kernel', 'python')
      const saved = await store.save(document.id, document.revision, document.title, [{ ...document.cells[0], source: 'counter = globals().get("counter", 0) + 1\nprint(counter)' }])
      const submit = (_language: 'python' | 'r', source: string, operation: string, session: string) => science.submit(source, operation, session)
      const first = await store.run(saved.id, saved.revision, saved.cells[0].id, 'notebook-run', submit)
      const duplicate = await store.run(saved.id, saved.revision, saved.cells[0].id, 'notebook-run', submit)
      expect(duplicate.execution.id).toBe(first.execution.id)
      expect(duplicate.document.cells[0].runs).toHaveLength(1)
      let job: Execution | undefined
      for (let count = 0; count < 100; count++) { job = science.get(first.execution.id); if (job?.state === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 20)) }
      expect(job?.state).toBe('succeeded'); expect(job?.output.trim()).toBe('1')
      const exported = store.export(saved.id, (_language, id) => science.get(id)) as any
      expect(exported.cells[0].outputs[0].text.trim()).toBe('1')
      expect(exported.cells[0].metadata.omicos.invocation_id).toBe(job?.id)
      const edited = await store.save(saved.id, duplicate.document.revision, 'Changed', [{ ...saved.cells[0], source: 'print(counter + 10)' }])
      expect((store.export(saved.id, (_language, id) => science.get(id)) as any).cells[0].outputs).toEqual([])
      await expect(store.run(edited.id, edited.revision, edited.cells[0].id, 'notebook-run', submit)).rejects.toThrow(/其他代码/)
      const second = await store.run(edited.id, edited.revision, edited.cells[0].id, 'second-run', submit)
      for (let count = 0; count < 100; count++) { job = science.get(second.execution.id); if (job?.state === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 20)) }
      expect(job?.output.trim()).toBe('11')
      const restored = await NotebookStore.open(directory)
      expect(restored.get(saved.id).cells[0].runs).toHaveLength(2)
      expect(await readFile(join(directory, '.omicos-oss', 'notebooks.json'), 'utf8')).not.toContain('text/html')
    } finally { await science.dispose() }
  })
})
