import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScienceLedger } from '../src/oss/ledger.js'
import { PipelineStore } from '../src/oss/pipeline-store.js'
import { FigureStudio } from '../src/oss/figures.js'
import { artifactBytes } from '../src/oss/artifact-bytes.js'
import { OssRuntime } from '../src/oss/runtime.js'
import type { FigureDraft, FigureSource } from '../src/oss/figure-types.js'
import type { Artifact, Execution } from '../src/oss/types.js'
let directory: string; let studio: FigureStudio
const source: FigureSource = { kind: 'project', language: 'python', executionId: 'execution', artifactId: 'figure' }
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
let bytes: Buffer; let artifact: Artifact; let receipt: Execution; let operation = 0
const draft = (fields: Partial<FigureDraft> = {}): FigureDraft => ({ title: 'Study figure', caption: 'Original result, unreviewed', source, methods: ['Method v1'], dataReferences: ['Declared samples.csv'], operationId: `figure-op-${++operation}`, ...fields })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oss-figures-')); await mkdir(join(directory, '.omicos-oss'))
  bytes = Buffer.from('raster-fixture'); artifact = { id: 'figure', path: '.omicos-oss/figure.png', mime: 'image/png', sha256: hash(bytes), bytes: bytes.length }
  receipt = { id: 'execution', operationId: 'execution', sessionId: 'session', language: 'python', state: 'succeeded', code: 'plot(values)', output: '', artifacts: [artifact], createdAt: '2026-10-25' }
  studio = await FigureStudio.open(directory, async () => ({ artifact, bytes, execution: receipt }))
})
afterEach(async () => { await studio.dispose(); await rm(directory, { recursive: true, force: true }) })
describe('immutable curated figures and human assessments', () => {
  it('pins execution/bytes, preserves reviewed history, resets assessment on edit and deduplicates retries', async () => {
    const request = draft(); const first = await studio.save(request, 'fixture:user')
    expect(first.review.state).toBe('draft'); expect(first.execution.codeSha256).toBe(hash(receipt.code))
    const approved = await studio.review({ id: first.id, revision: first.revision, decision: 'approved', note: 'Checked axes and sample units', operationId: 'review-once' }, 'fixture:reviewer')
    expect(approved.review.assessedDigest).toBe(first.digest)
    expect((await studio.save(request, 'fixture:user')).revision).toBe(approved.revision)
    await expect(studio.save({ ...request, caption: 'Changed request' }, 'fixture:user')).rejects.toThrow(/another request/)
    await expect(studio.save(draft({ id: first.id, revision: first.revision }), 'fixture:user')).rejects.toThrow(/changed/)
    const revised = await studio.save(draft({ id: first.id, revision: approved.revision, caption: 'Corrected sample size' }), 'fixture:user')
    expect(revised.review.state).toBe('draft'); expect(studio.get(first.id, approved.revision).review.state).toBe('approved')
    expect(studio.history(first.id).revisions.map(node => node.review.state)).toEqual(['draft', 'approved', 'draft'])
    expect(studio.manifest(first.id).figure.artifact.sha256).toBe(artifact.sha256)
    await studio.dispose(); studio = await FigureStudio.open(directory, async () => ({ artifact, bytes, execution: receipt }))
    expect(studio.get(first.id).caption).toBe('Corrected sample size')
    expect((await stat(join(directory, '.omicos-oss', 'figures.sqlite'))).mode & 0o777).toBe(0o600)
  })
  it('refuses changed bytes and pending work, retains withdrawal after original files disappear', async () => {
    receipt.state = 'running'; await expect(studio.save(draft(), 'user')).rejects.toThrow(/terminal/)
    receipt.state = 'failed'; const node = await studio.save(draft(), 'user')
    bytes = Buffer.from('tampered')
    await expect(studio.artifact(node.id)).rejects.toThrow(/no longer matches/)
    await expect(studio.review({ id: node.id, revision: node.revision, decision: 'approved', note: 'Looks okay', operationId: 'no-approval' }, 'human')).rejects.toThrow(/source bytes changed/)
    const withdrawn = await studio.review({ id: node.id, revision: node.revision, decision: 'withdrawn', note: 'Source lost, retain audit', operationId: 'withdraw' }, 'human')
    expect(withdrawn.review.state).toBe('withdrawn'); expect(studio.get(node.id, 1).review.state).toBe('draft')
    expect(studio.manifest(node.id).figure.execution.state).toBe('failed')
    expect((await studio.integrity(node.id)).state).toBe('changed')
  })
  it('paginates every figure and revision, retaining stable order under metadata updates', async () => {
    const nodes = []; for (let index = 0; index < 53; index++) nodes.push(await studio.save(draft({ title: `Figure ${index}` }), 'user'))
    const page = studio.list(); const rest = studio.list('', page.next)
    expect(page.entries).toHaveLength(50); expect(rest.entries).toHaveLength(3)
    expect(new Set([...page.entries, ...rest.entries].map(node => node.id)).size).toBe(53)
    let node = nodes[0]; for (let index = 0; index < 51; index++) node = await studio.save(draft({ id: node.id, revision: node.revision }), 'user')
    const history = studio.history(node.id); expect(history.revisions).toHaveLength(50); expect(studio.history(node.id, history.next).revisions).toHaveLength(2)
    expect(studio.list('Figure 52').entries).toHaveLength(1)
    await expect(studio.save(draft({ methods: [42 as any] }), 'user')).rejects.toThrow(/method references/)
  })
  it('pages execution and Pipeline candidates across artifact/attempt boundaries without duplicates', async () => {
    const ledger = await ScienceLedger.open(directory); const pipelines = await PipelineStore.open(directory)
    try {
      const artifacts = Array.from({ length: 61 }, (_, index) => ({ ...artifact, id: `artifact-${index}` }))
      ledger.saveExecutions('python', [{ ...receipt, artifacts: artifacts.slice(0, 31) }]); ledger.saveExecutions('r', [{ ...receipt, language: 'r', id: 'r-execution', operationId: 'r-execution', artifacts: artifacts.slice(31) }])
      const first = ledger.figureCandidates(); const rest = ledger.figureCandidates(first.next)
      expect(first.entries).toHaveLength(50); expect(rest.entries).toHaveLength(11)
      expect(new Set([...first.entries, ...rest.entries].map(entry => entry.artifact.id)).size).toBe(61)
      const definition = pipelines.define({ title: 'Fixture receipts', language: 'python', steps: [{ id: 'fixture', code: 'pass' }] })
      const run = pipelines.create(definition.id, 'fixture').run
      pipelines.update(run.id, run.revision, 'fixture/recorded', draft => { draft.state = 'succeeded'; draft.attempts = [0,1].map((value, index) => ({ id: `attempt-${index}`, step: 0, kind: 'step', operationId: `operation-${index}`, executionId: `execution-${index}`, state: 'succeeded', artifacts: index ? artifacts.slice(31) : artifacts.slice(0,31) })) })
      const page = pipelines.figureCandidates(); const next = pipelines.figureCandidates(page.next)
      expect(page.entries).toHaveLength(50); expect(next.entries).toHaveLength(11)
      expect(new Set([...page.entries, ...next.entries].map(entry => entry.artifact.id)).size).toBe(61)
      expect(() => ledger.figureCandidates('NaN:0')).toThrow(/cursor/); expect(() => pipelines.figureCandidates('1:0:Infinity')).toThrow(/cursor/)
    } finally { ledger.close(); pipelines.close() }
  })
  it('bounds artifact reads and rejects changed files and external symlinks', async () => {
    await writeFile(join(directory, artifact.path), bytes)
    expect(await artifactBytes(directory, artifact)).toEqual(bytes)
    await writeFile(join(directory, artifact.path), 'changed')
    await expect(artifactBytes(directory, artifact)).rejects.toThrow(/changed/)
    const outside = join(directory, '..', `${directory.split('/').at(-1)}-outside`)
    try { await writeFile(outside, bytes); await rm(join(directory, artifact.path)); await symlink(outside, join(directory, artifact.path)); await expect(artifactBytes(directory, artifact)).rejects.toThrow(/outside/) } finally { await rm(outside, { force: true }) }
    await expect(artifactBytes(directory, { ...artifact, bytes: 33 * 1024 * 1024, path: '.omicos-oss/figures.sqlite' })).rejects.toThrow(/32 MiB/)
  })
})
it('curates real Python PNG/PDF/SVG and Pipeline figures, survives restart and never re-executes on download', async () => {
  const runtime = await OssRuntime.open({ python: process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3', stateDir: join(directory, 'state') })
  let sourceRuntime = runtime
  const finish = async (service: any, id: string) => { for (let index = 0; index < 300; index++) { const job = service.get(id); if (!['running', 'queued'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, 20)) } throw Error('Scientific figure timeout') }
  try {
    const project = await runtime.project(join(directory, 'project'))
    const job = await finish(project, (await project.submit('import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3], [2,4,3])', 'actual-plot', 'session')).id)
    expect(job.state).toBe('succeeded'); expect(job.artifacts.map((item: Artifact) => item.mime)).toEqual(['image/png', 'application/pdf', 'image/svg+xml'])
    const studio = await runtime.figures(project.workspace); const node = await studio.save(draft({ source: { ...source, executionId: job.id, artifactId: job.artifacts[0].id } }), 'human')
    expect((await studio.artifact(node.id)).bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]))
    expect(project.figureCandidates().entries).toHaveLength(3)
    const pipelines = await runtime.pipelines(project.workspace)
    const definition = pipelines.define({ title: 'Pipeline plot', language: 'python', steps: [{ id: 'plot', code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.scatter([1,2], [3,4])' }] })
    const run = pipelines.start(definition.id, 'pipeline-figure')
    for (let index = 0; index < 300 && !['succeeded', 'failed'].includes(pipelines.get(run.id).state); index++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(pipelines.get(run.id).state).toBe('succeeded')
    const candidate = pipelines.store.figureCandidates().entries.find(item => item.artifact.mime === 'image/png')!
    const piped = await studio.save(draft({ source: candidate.source }), 'human')
    expect((await studio.artifact(piped.id)).bytes.length).toBe(piped.artifact.bytes)
    await runtime.dispose(); sourceRuntime = await OssRuntime.open({ stateDir: join(directory, 'state'), python: 'never-start-this-interpreter' })
    const reopened = await sourceRuntime.figures(project.workspace)
    expect((await reopened.artifact(node.id)).bytes.length).toBe(node.artifact.bytes)
    expect((await reopened.artifact(piped.id)).bytes.length).toBe(piped.artifact.bytes)
    const restored = await sourceRuntime.project(project.workspace); expect(restored.snapshot().kernel.state).toBe('cold')
    expect(restored.snapshot().executions).toHaveLength(1)
    await writeFile(join(project.workspace, node.artifact.path), 'overwritten')
    await expect(reopened.artifact(node.id)).rejects.toThrow(/changed/)
  } finally { await sourceRuntime.dispose() }
}, 30000)
