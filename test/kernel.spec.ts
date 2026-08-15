import { describe, expect, it, vi } from 'vitest'
import type { CoreHandle } from '@omicverse/omicos-launcher'
import { KernelManager, deriveOmicosSessionId } from '../src/host/kernel.js'

function handleStub(overrides: Partial<CoreHandle> = {}): CoreHandle {
  return {
    baseUrl: 'http://127.0.0.1:5099',
    port: 5099,
    pid: 42,
    spawned: false,
    stop: vi.fn(),
    ...overrides,
  }
}

describe('KernelManager', () => {
  it('memoizes the handle and single-flights concurrent callers', async () => {
    let resolveEnsure!: (h: CoreHandle) => void
    const ensureImpl = vi.fn(
      () => new Promise<CoreHandle>((resolve) => (resolveEnsure = resolve)),
    )
    const mgr = new KernelManager({ workspace: '/ws', ensureImpl })

    const [a, b] = [mgr.handle(), mgr.handle()]
    resolveEnsure(handleStub())
    expect(await a).toBe(await b)
    expect(ensureImpl).toHaveBeenCalledTimes(1)

    await mgr.handle()
    expect(ensureImpl).toHaveBeenCalledTimes(1)
  })

  it('a rejected ensure clears the inflight slot so the next handle() retries', async () => {
    const ensureImpl = vi
      .fn<() => Promise<CoreHandle>>()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(handleStub())
    const mgr = new KernelManager({ workspace: '/ws', ensureImpl })

    await expect(mgr.handle()).rejects.toThrow('spawn failed')
    await expect(mgr.handle()).resolves.toMatchObject({ port: 5099 })
    expect(ensureImpl).toHaveBeenCalledTimes(2)
  })

  it('dispose() stops the handle and wins even against an in-flight ensure', async () => {
    let resolveEnsure!: (h: CoreHandle) => void
    const ensureImpl = vi.fn(
      () => new Promise<CoreHandle>((resolve) => (resolveEnsure = resolve)),
    )
    const mgr = new KernelManager({ workspace: '/ws', ensureImpl })
    const pending = mgr.handle()

    mgr.dispose()
    const spawned = handleStub({ spawned: true })
    resolveEnsure(spawned)
    await pending
    expect(spawned.stop).toHaveBeenCalledTimes(1)
    await expect(mgr.handle()).rejects.toThrow(/disposed/)
  })

  it('reset() drops the memo without stopping anything', async () => {
    const first = handleStub()
    const second = handleStub({ port: 6000, baseUrl: 'http://127.0.0.1:6000' })
    const ensureImpl = vi
      .fn<() => Promise<CoreHandle>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const mgr = new KernelManager({ workspace: '/ws', ensureImpl })

    await mgr.handle()
    mgr.reset()
    expect(first.stop).not.toHaveBeenCalled()
    const h = await mgr.handle()
    expect(h.port).toBe(6000)
  })
})

describe('deriveOmicosSessionId', () => {
  it('is deterministic, prefixed, and path-component safe', () => {
    expect(deriveOmicosSessionId('abc-123')).toBe('dsh-abc-123')
    expect(deriveOmicosSessionId('abc-123')).toBe(deriveOmicosSessionId('abc-123'))
    expect(deriveOmicosSessionId('x/../../etc')).toBe('dsh-x-------etc')
    expect(deriveOmicosSessionId('a'.repeat(200))).toHaveLength(4 + 96)
  })
})
