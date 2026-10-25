import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { runtimeCapabilities } from '../src/oss/capabilities.js'
it('discovers actual integration state without starting configured interpreters or inventing remote capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oss-capabilities-'))
  const runtime = await OssRuntime.open({ stateDir: join(directory, 'state'), python: '/never-start-or-probe' })
  try {
    const project = await runtime.project(directory); const plain = runtimeCapabilities(runtime)
    expect(plain.runtimeVersion).toBe(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
    expect(plain.features.find(feature => feature.id === 'science.python')?.state).toBe('configured')
    expect(plain.features.find(feature => feature.id === 'agent.chat')?.state).toBe('optional')
    expect(plain.features.find(feature => feature.id === 'runner.ssh-slurm')?.state).toBe('unavailable')
    expect(project.snapshot().kernel.state).toBe('cold')
    runtime.chat = {} as never
    expect(runtimeCapabilities(runtime).features.find(feature => feature.id === 'agent.chat')?.state).toBe('available')
    expect(runtimeCapabilities(runtime, 'core').features.find(feature => feature.id === 'agent.chat')?.state).toBe('unavailable')
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) }
})
