import { describe, expect, it, vi } from 'vitest'
import { installedCoreCommand, resolveInstalledCore } from '../src/host/coreCommand.js'

describe('installedCoreCommand', () => {
  it('execs the installed shim with node and restates every flag the launcher would have added', () => {
    // 🔴 The override REPLACES the launcher's argv construction, so a missing
    // flag here is silent: the core would come up on the default data dir or
    // the default cloud rather than the ones this workspace asked for.
    const cmd = installedCoreCommand('/ws', 'https://staging.example', () => '/nm/@omicverse/omicos/bin/omicos.js')
    expect(cmd?.command).toBe(process.execPath)
    expect(cmd?.args).toEqual([
      '/nm/@omicverse/omicos/bin/omicos.js',
      'serve',
      '--host',
      '127.0.0.1',
      '--report-port',
      '--no-browser',
      '--data-dir',
      '/ws/.omicos',
      '--upstream-base-url',
      'https://staging.example',
    ])
  })

  it('falls back to the production cloud when no upstream is configured', () => {
    const cmd = installedCoreCommand('/ws', undefined, () => '/nm/omicos/bin/omicos.js')
    expect(cmd?.args.at(-1)).toBe('https://auth.omicos.cn')
  })

  it('answers undefined when the core dependency is not resolvable, leaving the launcher on npx', () => {
    expect(installedCoreCommand('/ws', undefined, () => undefined)).toBeUndefined()
  })
})

describe('resolveInstalledCore', () => {
  it('points at the shim inside the package, not at a platform binary', () => {
    const requireImpl = { resolve: vi.fn(() => '/nm/@omicverse/omicos/package.json') } as unknown as NodeJS.Require
    expect(resolveInstalledCore(requireImpl)).toBe('/nm/@omicverse/omicos/bin/omicos.js')
    expect(requireImpl.resolve).toHaveBeenCalledWith('@omicverse/omicos/package.json')
  })

  it('is undefined rather than throwing when the dependency is absent', () => {
    const requireImpl = {
      resolve: vi.fn(() => {
        throw new Error('Cannot find module')
      }),
    } as unknown as NodeJS.Require
    expect(resolveInstalledCore(requireImpl)).toBeUndefined()
  })
})
