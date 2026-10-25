import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('refreshes a stale Host CSRF nonce once and retries the exact stable operation after pre-dispatch rejection', async () => {
  let sessions = 0; let executed = 0; const payloads: string[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: ++sessions === 1 ? 'old-host' : 'new-host' }), { status: 200 })
    payloads.push(String(init?.body))
    if ((init?.headers as Record<string, string>)['x-omicos-csrf'] !== 'new-host') return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403 })
    executed++; return new Response(JSON.stringify({ id: 'accepted' }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  const { api } = await import('../src/client/oss-api.js')
  await api('session')
  expect(await api('project/id/execute', { operationId: 'stable', code: 'print(42)' })).toEqual({ id: 'accepted' })
  expect(executed).toBe(1); expect(payloads).toHaveLength(2); expect(payloads[0]).toBe(payloads[1]); expect(sessions).toBe(2)
})
it('never retries unknown checkout network failures or generic authorization denials', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Connection closed after dispatch')).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Cloud denied' }), { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  const { api } = await import('../src/client/oss-api.js')
  await expect(api('checkout', { confirmation: 'once' })).rejects.toThrow('Connection closed')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(api('checkout', { confirmation: 'other' })).rejects.toThrow('Cloud denied')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('does not replay a subscription mutation across an account/origin change after Host restart', async () => {
  let sessions = 0; let mutations = 0
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: `host-${sessions}`, account: { server: 'https://auth.omicos.cn', logged_in: true, user: { id: ++sessions === 1 ? 'user-one' : 'user-two' } } }), { status: 200 })
    mutations++; return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403 })
  })
  vi.stubGlobal('fetch', fetcher)
  const { api } = await import('../src/client/oss-api.js')
  await api('session')
  await expect(api('subscription/manage', { action: 'cancel', confirmed: true })).rejects.toThrow('账号')
  expect(mutations).toBe(1)
})
