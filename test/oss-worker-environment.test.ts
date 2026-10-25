import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { workerEnvironment } from '../src/oss/worker-environment.js'
import { ScienceService } from '../src/oss/science.js'

it('projects runtime variables and explicitly selected names instead of inheriting arbitrary Host secrets', () => {
  const source = { PATH: '/runtime/bin', HOME: '/user', LC_CTYPE: 'UTF-8', R_LIBS_USER: '/r-libs', DEEPSEEK_API_KEY: 'fake-model-secret', OPENAI_API_KEY: 'fake-openai-secret', CUSTOM_BIO_KEY: 'fake-science-key', OTHER_TOKEN: 'fake-other-secret' }
  const projected = workerEnvironment(source)
  expect(projected.PATH).toBe('/runtime/bin'); expect(projected.R_LIBS_USER).toBe('/r-libs'); expect(projected.MPLBACKEND).toBe('Agg')
  expect(projected).not.toHaveProperty('DEEPSEEK_API_KEY'); expect(projected).not.toHaveProperty('OTHER_TOKEN')
  const explicit = workerEnvironment(source, ['CUSTOM_BIO_KEY'])
  expect(explicit.CUSTOM_BIO_KEY).toBe('fake-science-key'); expect(explicit).not.toHaveProperty('OPENAI_API_KEY')
  expect(() => workerEnvironment(source, ['KEY=value'])).toThrow('names')
})
it('does not expose a synthetic Host secret to a real Python process by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omicos-worker-env-'))
  const name = 'OMICOS_TEST_HOST_SECRET'
  const previous = process.env[name]; process.env[name] = 'fake-host-only'
  const service = await ScienceService.open(directory)
  try {
    const job = await service.submit(`import os\nprint(${JSON.stringify(name)} in os.environ)`, 'env-check', 'research')
    for (let index = 0; index < 300 && ['queued','running'].includes(service.get(job.id)!.state); index++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(job.id)?.state).toBe('succeeded')
    expect(service.get(job.id)?.output).toContain('False')
  } finally { await service.dispose(); if (previous === undefined) delete process.env[name]; else process.env[name] = previous; await rm(directory, { recursive: true, force: true }) }
})
