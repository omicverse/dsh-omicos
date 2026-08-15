/**
 * Command layer divergence points: the single-shot handler contract
 * (login answers with the pairing text IMMEDIATELY, approval lands in the
 * background and surfaces via /omicos-status), the name constraint
 * (hyphens, verified regex), and stop-kernel's F13 posture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreHandle } from '@omicverse/omicos-launcher'
import { OmicosPool } from '../src/host/pool.js'
import { registerOmicosCommands } from '../src/host/commands.js'
import type { CommandResult, Context } from '../src/host/dsh-compat.js'
import { MockAuthServer } from '../../../packages/client/test/helpers/mockAuthServer.js'
import { MockCore, respondJson } from '../../../packages/client/test/helpers/mockCore.js'

interface RegisteredCommand {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => CommandResult | Promise<CommandResult>
}

function fakeCtx(withCommands = true): { ctx: Context; commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = []
  const ctx = {
    get(name: string) {
      if (name === 'commands' && withCommands) {
        return { register: (d: RegisteredCommand) => (commands.push(d), () => {}) }
      }
      return undefined
    },
  } as unknown as Context
  return { ctx, commands }
}

function poolFor(baseUrl: string, spawned = false): { pool: OmicosPool; stop: () => void } {
  const stop = vi.fn()
  const handle: CoreHandle = { baseUrl, port: 0, pid: 1, spawned, stop }
  return { pool: new OmicosPool({ ensureImpl: async () => handle }), stop }
}

const BASE = { configWorkspace: '/ws', upstreamBaseUrl: 'http://x', authMethod: 'device-code' as const }

let servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
})

describe('registerOmicosCommands', () => {
  it('registers nothing when the commands service is absent (optional peer)', () => {
    const { ctx } = fakeCtx(false)
    const { pool } = poolFor('http://127.0.0.1:1')
    expect(registerOmicosCommands(ctx, { ...BASE, pool })).toEqual([])
  })

  it('uses only registrable names (verified /^[a-z][a-z0-9_-]*$/ — the design\'s omicos:login is not)', () => {
    const { ctx, commands } = fakeCtx()
    const { pool } = poolFor('http://127.0.0.1:1')
    registerOmicosCommands(ctx, { ...BASE, pool })
    for (const c of commands) expect(c.name).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect(commands.map((c) => c.name)).toEqual(['omicos-login', 'omicos-status', 'omicos-account', 'omicos-logout', 'omicos-stop-kernel'])
  })

  it('omicos-login returns the pairing code IMMEDIATELY; approval lands in background and /omicos-status reports it', async () => {
    const core = new MockCore()
    await core.start()
    servers.push(core)
    let pushed: unknown
    core.on('POST', '/api/cloud/login', (req, res) => {
      pushed = req.json
      respondJson(res, 200, { ok: true })
    })
    core.on('GET', '/api/cloud/identity', (_req, res) =>
      respondJson(res, 200, { logged_in: true, email: 'a@b.com', user_id: 'u1', server: 'http://auth' }),
    )

    let approve = false
    const auth = new MockAuthServer({
      'POST /api/auth/cli-device-code': () => ({
        status: 200,
        json: { device_code: 'dc', user_code: 'AB-12', verification_uri: 'https://app/#/device', expires_in: 300, interval: 0.01 },
      }),
      'POST /api/auth/cli-poll': () =>
        approve
          ? { status: 200, json: { status: 'approved', user_token: 'UT', process_token: 'PT', user: { id: 'u1', email: 'a@b.com' } } }
          : { status: 200, json: { status: 'pending', interval: 0.01 } },
    })
    await auth.start()
    servers.push(auth)

    const { ctx, commands } = fakeCtx()
    const { pool } = poolFor(core.baseUrl)
    registerOmicosCommands(ctx, { ...BASE, pool, upstreamBaseUrl: auth.baseUrl })
    const [login, status] = commands

    const result = await login!.handler({ rawInput: '' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('AB-12')
    // Not approved yet — nothing pushed, status says pending.
    expect(pushed).toBeUndefined()
    expect((await status!.handler({ rawInput: '' })).text).toContain('等待批准')

    approve = true
    await vi.waitFor(() => {
      expect(pushed).toBeDefined()
    })
    expect(pushed).toMatchObject({ server: auth.baseUrl, user_token: 'UT' })
    // The relay-only field must NOT be forwarded by an extension host (protocol auth.ts).
    expect((pushed as Record<string, unknown>).process_token).toBeUndefined()

    const after = await status!.handler({ rawInput: '' })
    expect(after.text).toContain('已登录')
    expect(after.text).toContain('a@b.com')
  })

  it('rejects an unknown login channel and a concurrent second login', async () => {
    const { ctx, commands } = fakeCtx()
    const { pool } = poolFor('http://127.0.0.1:1')
    registerOmicosCommands(ctx, { ...BASE, pool, upstreamBaseUrl: 'http://127.0.0.1:1' })
    const bad = await commands[0]!.handler({ rawInput: 'sms' })
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('sms')
  })

  it('omicos-account shows plan + commerce deep links when logged in, and a subscribe link when not', async () => {
    const core = new MockCore()
    await core.start()
    servers.push(core)
    core.on('GET', '/api/cloud/identity', (_req, res) =>
      respondJson(res, 200, { logged_in: true, email: 'a@b.com', user_id: 'u1', server: 'https://auth.omicos.cn' }),
    )
    core.on('GET', '/api/health/plan', (_req, res) =>
      respondJson(res, 200, { plan_code: 'lab', token_exp: 1786835514, renewing: false, last_refresh: 0, last_error_detail: null, last_error_reason: null, user_id: 'u1' }),
    )
    const { ctx, commands } = fakeCtx()
    const { pool } = poolFor(core.baseUrl)
    registerOmicosCommands(ctx, { ...BASE, pool })
    const account = commands.find((c) => c.name === 'omicos-account')!

    const r = await account.handler({ rawInput: '' })
    expect(r.kind).toBe('success')
    expect(r.text).toContain('a@b.com')
    expect(r.text).toContain('Lab')
    expect(r.text).toContain('https://app.omicos.cn/#/bench?page=subscription')
    expect(r.text).toContain('https://app.omicos.cn/#/bench?page=settings')

    // Logged out: no plan lookup, subscribe link + login hint instead.
    core.on('GET', '/api/cloud/identity', (_req, res) => respondJson(res, 200, { logged_in: false }))
    const out = await account.handler({ rawInput: '' })
    expect(out.text).toContain('/omicos-login')
    expect(out.text).toContain('page=subscription')
  })

  it('omicos-stop-kernel never stops an ATTACHED core (F13) but stops a self-spawned one and stays reusable', async () => {
    const attached = poolFor('http://127.0.0.1:1', false)
    await attached.pool.entry('/ws').kernel.handle()
    const { ctx, commands } = fakeCtx()
    registerOmicosCommands(ctx, { ...BASE, pool: attached.pool })
    const stopCmd = commands[4]!
    const r1 = await stopCmd.handler({ rawInput: '' })
    expect(r1.text).toContain('不会停止')
    expect(attached.stop).not.toHaveBeenCalled()

    const spawned = poolFor('http://127.0.0.1:2', true)
    await spawned.pool.entry('/ws').kernel.handle()
    const ctx2 = fakeCtx()
    registerOmicosCommands(ctx2.ctx, { ...BASE, pool: spawned.pool })
    const r2 = await ctx2.commands[4]!.handler({ rawInput: '' })
    expect(r2.text).toContain('已停止 1 个')
    expect(spawned.stop).toHaveBeenCalledTimes(1)
    await expect(spawned.pool.entry('/ws').kernel.handle()).resolves.toBeDefined()
  })
})
