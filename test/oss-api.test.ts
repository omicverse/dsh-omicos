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

it('sends the observed cloud identity on mutations and never retries a stale-window rejection', async () => {
  let mutationHeader: string | undefined
  const account = { server: 'https://auth.omicos.cn', logged_in: true, user: { id: '账户-user' }, generation: 7 }
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: 'host', account }), { status: 200 })
    mutationHeader = (init?.headers as Record<string, string>)['x-omicos-account']
    return new Response(JSON.stringify({ error: 'Cloud account changed; refresh before submitting' }), { status: 409 })
  })
  vi.stubGlobal('fetch', fetcher)
  const { api } = await import('../src/client/oss-api.js')
  await api('session')
  await expect(api('subscription/manage', { action: 'cancel', confirmed: true })).rejects.toThrow('云账号已变化')
  expect(mutationHeader).toBe(encodeURIComponent(JSON.stringify([account.server, true, account.user.id, 7])))
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('keeps a form bound to its rendered account even if a background session refresh observes another account', async () => {
  const original = { server: 'https://auth.omicos.cn', logged_in: true, user: { id: 'old-user' }, generation: 1 }
  const current = { ...original, user: { id: 'new-user' }, generation: 3 }
  let observed: string | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: 'same-host', account: current }))
    observed = (init?.headers as Record<string, string>)['x-omicos-account']
    return new Response(JSON.stringify({ error: 'Cloud account changed; refresh before submitting' }), { status: 409 })
  }))
  const { api } = await import('../src/client/oss-api.js')
  await api('session')
  await expect(api('invoice', { confirmed: true }, undefined, original)).rejects.toThrow('本次操作未发送')
  expect(observed).toBe(encodeURIComponent(JSON.stringify([original.server, true, original.user.id, 1])))
})

it('keeps local workspace resolution independent of cloud account changes during CSRF recovery', async () => {
  let sessions = 0; let attempts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: `nonce-${++sessions}`, account: { server: 'https://auth.omicos.cn', logged_in: true, user: { id: `user-${sessions}` }, generation: sessions } }))
    return ++attempts === 1 ? new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403 }) : new Response(JSON.stringify({ id: 'local-project' }))
  }))
  const { api } = await import('../src/client/oss-api.js')
  await api('session')
  expect(await api('open-session-project', { sessionId: 'same-workspace' })).toEqual({ id: 'local-project' })
  expect(attempts).toBe(2)
})
it('sends an explicit scientific protocol and refuses automatic fallback after version rejection', async () => {
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return new Response(JSON.stringify({ error: 'Unsupported OmicOS scientific protocol; inspect capabilities before retrying', protocol: 2 }), { status: 426 }) }))
  const { api } = await import('../src/client/oss-api.js')
  await expect(api('project/fixture/execute', { operationId: 'never-dispatch', code: 'print(42)' })).rejects.toMatchObject({ status: 426 })
  expect(requests).toHaveLength(1); expect((requests[0].headers as Record<string, string>)['x-omicos-protocol']).toBe('1')
})
it('retries binary chunks only after the precise pre-dispatch CSRF rejection, preserving exact offset and bytes',async()=>{
  let sessions=0;const bodies:unknown[]=[];const paths:string[]=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(url.endsWith('/session'))return new Response(JSON.stringify({csrf:++sessions===1?'old':'new'}));bodies.push(init?.body);paths.push(url);return (init?.headers as Record<string,string>)['x-omicos-csrf']==='old'?new Response(JSON.stringify({error:'Invalid CSRF token'}),{status:403}):new Response(JSON.stringify({received:4194304}))}))
  const {api,apiUploadChunk}=await import('../src/client/oss-api.js');await api('session');const bytes=new Uint8Array([1,2,3]).buffer
  expect(await apiUploadChunk('project/id/upload-chunk?id=stable&offset=0',bytes)).toEqual({received:4194304});expect(paths).toHaveLength(2);expect(paths[0]).toBe(paths[1]);expect(bodies[0]).toBe(bytes);expect(bodies[1]).toBe(bytes)
})
it('does not replay a binary upload on unknown network outcomes or protocol rejection',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error('Response lost after chunk committed')).mockResolvedValueOnce(new Response(JSON.stringify({error:'Protocol mismatch'}),{status:426}));vi.stubGlobal('fetch',fetcher)
  const {apiUploadChunk}=await import('../src/client/oss-api.js');const bytes=new ArrayBuffer(0)
  await expect(apiUploadChunk('project/id/upload-chunk?id=stable&offset=0',bytes)).rejects.toThrow('Response lost');expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(apiUploadChunk('project/id/upload-chunk?id=stable&offset=0',bytes)).rejects.toMatchObject({status:426});expect(fetcher).toHaveBeenCalledTimes(2)
})
