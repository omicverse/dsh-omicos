import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { ScienceService } from '../src/oss/science.js'

describe('durable lazy project registry', () => {
  let directory: string; const runtimes: OssRuntime[] = []
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'omicos-registry-')) })
  afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await rm(directory, { recursive: true, force: true }) })
  const open = async () => { const runtime = await OssRuntime.open({ stateDir: join(directory, 'state') }); runtimes.push(runtime); return runtime }
  it('restores known project IDs after restart without acquiring every project lock', async () => {
    const first = await open()
    await first.project(join(directory, 'project'))
    const references = await first.list()
    await first.dispose()
    const second = await open()
    expect(await second.list()).toEqual(references)
    const independent = await ScienceService.open(references[0].workspace)
    await expect(second.byId(references[0].id)).rejects.toThrow(/lock/i)
    await independent.dispose()
    const restored = await second.byId(references[0].id)
    expect(restored.snapshot().kernel.state).toBe('cold')
  })
  it('deduplicates concurrent project registration and workspace aliases', async () => {
    const runtime = await open()
    const workspace = join(directory, 'project')
    const [one, two] = await Promise.all([runtime.project(workspace), runtime.project(workspace)])
    expect(one).toBe(two)
    await symlink(workspace, join(directory, 'alias'))
    expect(await runtime.project(join(directory, 'alias'))).toBe(one)
    expect(await runtime.list()).toHaveLength(1)
  })
  it('does not recreate a deleted workspace when its old ID is addressed', async () => {
    const first = await open(); await first.project(join(directory, 'project'))
    const reference = (await first.list())[0]
    await first.dispose(); await rename(reference.workspace, join(directory, 'moved'))
    const second = await open()
    await expect(second.byId(reference.id)).rejects.toThrow()
  })
})
