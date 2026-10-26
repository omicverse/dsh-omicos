import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { normalizePipeline, digest } from '../src/oss/pipeline-store.js'
import type { PipelineService } from '../src/oss/pipelines.js'
import type { PipelineRun } from '../src/oss/pipeline-types.js'
let directory: string; let runtime: OssRuntime
const options = () => ({ stateDir: join(directory, 'state'), python: process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3' })
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-pipelines-')); runtime = await OssRuntime.open(options()) })
afterEach(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
async function wait(service: PipelineService, id: string, predicate: (run: PipelineRun) => boolean): Promise<PipelineRun> {
  for (let count = 0; count < 400; count++) { const run = service.get(id); if (predicate(run)) return run; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`Pipeline timed out: ${JSON.stringify(service.get(id))}`)
}
const definition = () => ({ title: 'Checkpointed analysis', language: 'python', parameters: { base: 40 }, inputs: ['data.txt'], references: [{ id: 'method', version: '1', text: 'Original method guidance', sha256: digest('Original method guidance') }], steps: [
  { id: 'prepare', title: 'Prepare durable state', code: 'import json\nfrom pathlib import Path\nvalue = pipeline_parameters["base"]\nPath("checkpoint.json").write_text(json.dumps({"value": value}))\ncount = Path("execution-count.txt")\ncount.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")', checkpoint: { files: ['checkpoint.json'], restoreCode: 'import json\nfrom pathlib import Path\nvalue = json.loads(Path("checkpoint.json").read_text())["value"]' } },
  { id: 'report', title: 'Confirm report', gate: true, code: 'print(value + 2)\nPath("result.txt").write_text(str(value + 2))', outputs: ['result.txt'] },
] })
describe('immutable, recoverable local scientific Pipelines', () => {
  it('pins normalized definition, source references and bindings without executing code', async () => {
    const service = await runtime.pipelines(directory)
    const first = service.define(definition()); const duplicate = service.define({ ...definition(), parameters: { base: 40 } })
    expect(first.id).toBe(duplicate.id); expect(service.list().definitions).toHaveLength(1)
    const changed = service.define({ ...definition(), parameters: { base: 41 } }); expect(changed.id).not.toBe(first.id)
    expect(service.store.definition(first.id).parameters.base).toBe(40)
    expect(() => normalizePipeline({ ...definition(), references: [{ ...definition().references[0], sha256: 'wrong' }] })).toThrow(/hash/)
    expect(() => normalizePipeline({ ...definition(), inputs: ['../secret'] })).toThrow(/relative/)
    expect(() => normalizePipeline({ ...definition(), inputs: ['result.txt'] })).toThrow(/Raw inputs/)
    expect(service.list().runs).toHaveLength(0)
  })
  it('runs isolated cells with pinned parameters, pauses at a human gate, and deduplicates start', async () => {
    await writeFile(join(directory, 'data.txt'), 'input')
    const parent = await runtime.project(directory); const job = await parent.submit('value = 99', 'ad-hoc', 'test')
    for (let count = 0; count < 100 && parent.get(job.id)?.state !== 'succeeded'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    const service = await runtime.pipelines(directory); const pinned = service.define(definition())
    const run = service.start(pinned.id, 'one-start'); expect(service.start(pinned.id, 'one-start').id).toBe(run.id)
    const waiting = await wait(service, run.id, run => run.state === 'waiting')
    expect(waiting.nextStep).toBe(1); expect(waiting.checkpoints).toHaveLength(1)
    await expect(readFile(join(directory, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.control(run.id, 1, 'continue')).rejects.toMatchObject({ status: 409 })
    await service.control(run.id, waiting.revision, 'continue')
    const done = await wait(service, run.id, run => run.state === 'succeeded')
    expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('42')
    const execution = await service.execution(run.id, done.attempts.at(-1)!.executionId!)
    expect(execution.output).toContain('42'); expect(done.attempts.at(-1)?.files?.[0].sha256).toBe(digest('42'))
    const check = await parent.submit('print(value)', 'ad-hoc-check', 'test')
    for (let count = 0; count < 100 && parent.get(check.id)?.state !== 'succeeded'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(parent.get(check.id)?.output.trim()).toBe('99')
    expect(service.store.events(run.id).some(event => event.type === 'approval/granted')).toBe(true)
  })
  it('restores a verified checkpoint after Host restart without repeating completed preparation', async () => {
    await writeFile(join(directory, 'data.txt'), 'input')
    let service = await runtime.pipelines(directory); const pinned = service.define(definition()); const run = service.start(pinned.id, 'restart-host')
    const waiting = await wait(service, run.id, run => run.state === 'waiting')
    await runtime.dispose(); runtime = await OssRuntime.open(options()); service = await runtime.pipelines(directory)
    const interrupted = service.get(run.id)
    expect(interrupted.state).toBe('interrupted')
    await expect(service.control(run.id, interrupted.revision, 'continue')).rejects.toMatchObject({ status: 409 })
    await expect(service.control(run.id, interrupted.revision, 'checkpoint', { checkpointAttemptId: waiting.checkpoints[0].attemptId })).rejects.toMatchObject({ status: 400 })
    await service.control(run.id, interrupted.revision, 'checkpoint', { checkpointAttemptId: waiting.checkpoints[0].attemptId, sideEffectsReviewed: true })
    const restored = await wait(service, run.id, run => run.state === 'waiting' && run.epoch === 1)
    expect(restored.attempts.filter(attempt => attempt.kind === 'restore' && attempt.state === 'succeeded')).toHaveLength(1)
    await service.control(run.id, restored.revision, 'continue')
    await wait(service, run.id, run => run.state === 'succeeded')
    expect(await readFile(join(directory, 'execution-count.txt'), 'utf8')).toBe('1')
    expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('42')
  })
  it('blocks changed checkpoint bytes and changed environments before restore code executes', async () => {
    await writeFile(join(directory, 'data.txt'), 'input')
    const service = await runtime.pipelines(directory); const pinned = service.define(definition()); const run = service.start(pinned.id, 'modified-checkpoint')
    let waiting = await wait(service, run.id, run => run.state === 'waiting')
    await writeFile(join(directory, 'checkpoint.json'), '{"value": 900}')
    await service.control(run.id, waiting.revision, 'checkpoint', { checkpointAttemptId: waiting.checkpoints[0].attemptId, sideEffectsReviewed: true })
    let failed = await wait(service, run.id, run => run.state === 'failed')
    expect(failed.reason).toContain('changed'); expect(failed.attempts).toHaveLength(1)
    await writeFile(join(directory, 'checkpoint.json'), '{"value": 40}')
    service.store.update(run.id, undefined, 'test/environment-mismatch', draft => { draft.environment!.fingerprint = 'changed-environment' })
    failed = service.get(run.id)
    await service.control(run.id, failed.revision, 'checkpoint', { checkpointAttemptId: failed.checkpoints[0].attemptId, sideEffectsReviewed: true })
    failed = await wait(service, run.id, run => run.state === 'failed')
    expect(failed.reason).toContain('Environment changed'); expect(failed.attempts).toHaveLength(1)
    await service.control(run.id, failed.revision, 'checkpoint', { checkpointAttemptId: failed.checkpoints[0].attemptId, sideEffectsReviewed: true, allowEnvironmentChange: true })
    waiting = await wait(service, run.id, run => run.state === 'waiting')
    expect(waiting.recoveries.at(-1)).toMatchObject({ allowEnvironmentChange: true, expectedFingerprint: 'changed-environment', observedFingerprint: waiting.environment?.fingerprint })
    await service.control(run.id, waiting.revision, 'reject')
    expect(service.get(run.id).state).toBe('canceled')
  })
  it('waits for actual cancellation and never silently replays unknown or failed steps', async () => {
    const service = await runtime.pipelines(directory)
    const pinned = service.define({ title: 'Cancelable', language: 'python', steps: [{ id: 'slow', code: 'from pathlib import Path\nimport time\nPath("started.txt").write_text("started")\ntime.sleep(30)\nPath("must-not-exist.txt").write_text("bad")' }] })
    const run = service.start(pinned.id, 'cancel-me')
    for (let count = 0; count < 200; count++) { try { await readFile(join(directory, 'started.txt')); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) } }
    await service.control(run.id, 0, 'cancel')
    const canceled = await wait(service, run.id, run => run.state === 'canceled')
    expect(canceled.attempts[0].state).toBe('canceled')
    await expect(readFile(join(directory, 'must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.control(run.id, canceled.revision, 'restart')).rejects.toMatchObject({ status: 400 })
    expect(service.start(pinned.id, 'cancel-me').id).toBe(run.id)
    expect(service.get(run.id).attempts).toHaveLength(1)
  })
  it('records Host interruption without restarting background work, and reserves declared output paths', async () => {
    const service = await runtime.pipelines(directory)
    const pinned = service.define({ title: 'Interrupt safely', language: 'python', steps: [{ id: 'work', outputs: ['reserved.txt'], code: 'from pathlib import Path\nimport time\nPath("host-started.txt").write_text("yes")\ntime.sleep(30)\nPath("must-not-finish.txt").write_text("bad")' }] })
    const run = service.start(pinned.id, 'host-interrupted')
    expect(() => service.start(pinned.id, 'conflicting-paths')).toThrow(/overlap/)
    for (let count = 0; count < 200; count++) { try { await readFile(join(directory, 'host-started.txt')); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) } }
    await runtime.dispose(); runtime = await OssRuntime.open(options())
    const reopened = await runtime.pipelines(directory)
    expect(reopened.get(run.id).state).toBe('interrupted')
    expect(reopened.start(pinned.id, 'host-interrupted').id).toBe(run.id)
    await expect(readFile(join(directory, 'must-not-finish.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reopened.get(run.id).attempts).toHaveLength(1)
  })

})
