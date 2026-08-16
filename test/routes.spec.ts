/**
 * `/omicos/*` route divergence points: the loopback pin (D11 — dsh's
 * trust fence is not authentication), snapshot passthrough, login-start's
 * structured display fields, and the busy conflict.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CoreHandle } from '@omicverse/omicos-launcher'
import { AccountService } from '../src/host/account.js'
import { ActivityStore } from '../src/host/activity-store.js'
import { OmicosPool } from '../src/host/pool.js'
import { registerOmicosRoutes } from '../src/host/routes.js'
import type { Context } from '../src/host/dsh-compat.js'
import { MockCore, respondJson } from '../../../packages/client/test/helpers/mockCore.js'
import { MockAuthServer } from '../../../packages/client/test/helpers/mockAuthServer.js'

type Handler = (req: unknown, res: unknown) => void | Promise<void>

function fakeCtx(): { ctx: Context; routes: Array<{ kind: string; path: string; handler: Handler }> } {
  const routes: Array<{ kind: string; path: string; handler: Handler }> = []
  const ctx = {
    get(name: string) {
      if (name === 'webServer') {
        return { register: (r: (typeof routes)[number]) => (routes.push(r), () => {}) }
      }
      return undefined
    },
  } as unknown as Context
  return { ctx, routes }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers: Record<string, unknown>) {
      res.statusCode = status
      res.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.body += chunk
    },
  }
  return res
}

function fakeReq(method: string, url: string, remoteAddress = '127.0.0.1', body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

function accountFor(baseUrl: string, upstream = 'http://127.0.0.1:1'): AccountService {
  const handle: CoreHandle = { baseUrl, port: 0, pid: 1, spawned: false, stop: vi.fn() }
  const pool = new OmicosPool({ ensureImpl: async () => handle })
  return new AccountService(pool, '/ws', upstream)
}

async function json(res: ReturnType<typeof fakeRes>): Promise<unknown> {
  return JSON.parse(res.body)
}

describe('registerOmicosRoutes', () => {
  it('registers nothing without a webServer service; registers one /omicos prefix route with it', () => {
    const bare = { get: () => undefined } as unknown as Context
    expect(registerOmicosRoutes(bare, { account: accountFor('http://x') })).toEqual([])

    const { ctx, routes } = fakeCtx()
    registerOmicosRoutes(ctx, { account: accountFor('http://x') })
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/omicos' })
  })

  it('🔴 refuses non-loopback callers on every route (403, no body leakage)', async () => {
    const { ctx, routes } = fakeCtx()
    registerOmicosRoutes(ctx, { account: accountFor('http://x') })
    const res = fakeRes()
    await routes[0]!.handler(fakeReq('GET', '/omicos/account', '192.168.1.20'), res)
    expect(res.statusCode).toBe(403)
    expect(await json(res)).toEqual({ error: 'loopback only' })
  })

  it('GET /omicos/account returns the snapshot; unknown paths 404', async () => {
    const core = new MockCore()
    await core.start()
    try {
      core.on('GET', '/api/cloud/identity', (_req, res) =>
        respondJson(res, 200, { logged_in: true, email: 'a@b.com', user_id: 'u1', server: 'https://auth' }),
      )
      core.on('GET', '/api/health/plan', (_req, res) =>
        respondJson(res, 200, { plan_code: 'pro', token_exp: 1786835514, renewing: true, last_refresh: 0, last_error_detail: null, last_error_reason: null, user_id: 'u1' }),
      )
      const { ctx, routes } = fakeCtx()
      registerOmicosRoutes(ctx, { account: accountFor(core.baseUrl) })

      const res = fakeRes()
      await routes[0]!.handler(fakeReq('GET', '/omicos/account'), res)
      expect(res.statusCode).toBe(200)
      expect(await json(res)).toMatchObject({
        logged_in: true,
        email: 'a@b.com',
        plan: { code: 'pro', name: 'Pro', renewing: true },
        subscribe_url: 'https://app.omicos.cn/#/bench?page=subscription',
      })

      const missing = fakeRes()
      await routes[0]!.handler(fakeReq('GET', '/omicos/nope'), missing)
      expect(missing.statusCode).toBe(404)
    } finally {
      await core.close()
    }
  })

  it('GET /omicos/activity/<callId> serves the live feed; unknown call answers 404 with a hint', async () => {
    const { ctx, routes } = fakeCtx()
    const activity = new ActivityStore({ now: () => 0 })
    activity.publish('call-1', { n: 3, phase: 'tool', tool: 'run_python_code', progress: ['UMAP 42%'] })
    registerOmicosRoutes(ctx, { account: accountFor('http://x'), activity })

    const res = fakeRes()
    await routes[0]!.handler(fakeReq('GET', '/omicos/activity/call-1'), res)
    expect(res.statusCode).toBe(200)
    expect(await json(res)).toMatchObject({ running: true, snapshot: { n: 3, tool: 'run_python_code' } })

    const missing = fakeRes()
    await routes[0]!.handler(fakeReq('GET', '/omicos/activity/nope'), missing)
    expect(missing.statusCode).toBe(404)
  })

  it('GET /omicos/figure proxies image bytes with containment (no traversal, no absolute, images only)', async () => {
    const core = new MockCore()
    await core.start()
    try {
      core.on('GET', '/api/files/preview', (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from([0x89, 0x50]))
      })
      const handle: CoreHandle = { baseUrl: core.baseUrl, port: 0, pid: 1, spawned: false, stop: vi.fn() }
      const pool = new OmicosPool({ ensureImpl: async () => handle })
      const { ctx, routes } = fakeCtx()
      registerOmicosRoutes(ctx, { account: accountFor(core.baseUrl), pool })

      const ok = fakeRes()
      await routes[0]!.handler(fakeReq('GET', `/omicos/figure?ws=${encodeURIComponent('/ws')}&path=${encodeURIComponent('figures/umap.png')}`), ok)
      expect(ok.statusCode).toBe(200)
      expect(ok.headers['content-type']).toBe('image/png')

      for (const bad of ['../../etc/passwd.png', '/abs/x.png', 'results/table.csv']) {
        const res = fakeRes()
        await routes[0]!.handler(fakeReq('GET', `/omicos/figure?ws=${encodeURIComponent('/ws')}&path=${encodeURIComponent(bad)}`), res)
        expect(res.statusCode).toBe(400)
      }
    } finally {
      await core.close()
    }
  })

  it('POST /omicos/login/start returns display fields; a second concurrent start answers 409', async () => {
    const auth = new MockAuthServer({
      'POST /api/auth/cli-device-code': () => ({
        status: 200,
        json: { device_code: 'dc', user_code: 'ZZ-99', verification_uri: 'https://app/#/device', expires_in: 300, interval: 5 },
      }),
      'POST /api/auth/cli-poll': () => ({ status: 200, json: { status: 'pending', interval: 5 } }),
    })
    await auth.start()
    try {
      const { ctx, routes } = fakeCtx()
      registerOmicosRoutes(ctx, { account: accountFor('http://127.0.0.1:1', auth.baseUrl) })

      const res = fakeRes()
      await routes[0]!.handler(fakeReq('POST', '/omicos/login/start', '127.0.0.1', {}), res)
      expect(res.statusCode).toBe(200)
      expect(await json(res)).toMatchObject({ user_code: 'ZZ-99', verification_uri: 'https://app/#/device' })

      const busy = fakeRes()
      await routes[0]!.handler(fakeReq('POST', '/omicos/login/start', '127.0.0.1', {}), busy)
      expect(busy.statusCode).toBe(409)

      const state = fakeRes()
      await routes[0]!.handler(fakeReq('GET', '/omicos/login/state'), state)
      expect(await json(state)).toMatchObject({ pending: true })
    } finally {
      await auth.close()
    }
  })
})
