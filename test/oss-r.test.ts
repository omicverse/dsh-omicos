import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScienceService } from '../src/oss/science.js'
import { OssRuntime } from '../src/oss/runtime.js'

let rAvailable = false
try { await promisify(execFile)('Rscript', ['--vanilla', '-e', 'stopifnot(requireNamespace("jsonlite", quietly=TRUE))'], { timeout: 10000 }); rAvailable = true } catch {}
async function settled(service: ScienceService, id: string) {
  for (let i = 0; i < 300; i++) { const job = service.get(id)!; if (!['running', 'queued'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('R execution timed out')
}
describe.skipIf(!rAvailable)('real persistent R worker', () => {
  it('keeps R variables between cells, generates verifiable PDF/PNG, and isolates Python', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omicos-r-'))
    const runtime = await OssRuntime.open({ stateDir: join(directory, 'state') })
    try {
      const workspace = join(directory, 'project')
      const r = await runtime.rProject(workspace)
      const first = await r.submit('values <- c(1,2,3,4)\nmean(values)', 'one', 'session')
      const result = await settled(r, first.id)
      expect(result.environment?.language).toBe('r'); expect(result.environment?.packages.jsonlite).toBeTruthy(); expect(result.state).toBe('succeeded'); expect(result.output).toContain('2.5')
      expect(result.artifacts).toHaveLength(0)
      const plot = await r.submit('plot(values, type="b", main="OmicOS R")', 'plot', 'session')
      const figure = await settled(r, plot.id)
      expect(figure.state).toBe('succeeded')
      expect(figure.artifacts.some(artifact => artifact.mime === 'application/pdf')).toBe(true)
      for (const artifact of figure.artifacts) { expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/); expect((await readFile(join(workspace, artifact.path))).length).toBe(artifact.bytes) }
      expect(r.snapshot().variables.find(variable => variable.name === 'values')).toBeTruthy()
      const py = await runtime.project(workspace)
      const book = await py.notebooks.create('R notebook', 'r')
      const saved = await py.notebooks.save(book.id, book.revision, book.title, [{ ...book.cells[0], source: 'print(sum(values))' }])
      const cell = await py.notebooks.run(saved.id, saved.revision, saved.cells[0].id, 'r-notebook', (language, source, operation, session) => { expect(language).toBe('r'); return r.submit(source, operation, session) })
      expect((await settled(r, cell.execution.id)).output).toContain('10')
      const exported = py.notebooks.export(book.id, (_language, id) => r.get(id)) as any
      expect(exported.metadata.kernelspec.name).toBe('ir')
      expect(exported.cells[0].metadata.omicos.environment.language).toBe('r')
      const check = await py.submit('print("values" in globals())', 'check', 'session')
      expect((await settled(py, check.id)).output).toContain('False')
      expect((r.notebook() as any).metadata.kernelspec.language).toBe('r')
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
  it('recovers after R errors and cancellation without silently replacing the namespace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omicos-r-cancel-'))
    const r = await ScienceService.open(workspace, 'Rscript', 'r')
    try {
      const bad = await r.submit('stop("test error")', 'bad', 'session')
      expect((await settled(r, bad.id)).state).toBe('failed')
      const slow = await r.submit('Sys.sleep(30)', 'slow', 'session')
      while (r.get(slow.id)?.state !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
      await new Promise(resolve => setTimeout(resolve, 200)); await r.cancel(slow.id)
      expect((await settled(r, slow.id)).state).toBe('canceled')
      const next = await r.submit('print(42)', 'next', 'session')
      expect((await settled(r, next.id)).output).toContain('42')
    } finally { await r.dispose(); await rm(workspace, { recursive: true, force: true }) }
  })
})
