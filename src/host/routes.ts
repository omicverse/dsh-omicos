/**
 * Same-origin JSON routes for the account tab (DSH-PLUGIN.md §4 routes.ts):
 * the browser half fetches `/omicos/*` on the dsh web origin; the host half
 * answers from the shared `AccountService`.
 *
 * 🔴 Loopback pin on EVERY route (D11): dsh's own `/api` is Host-header
 * trust only — "explicitly not authentication" — and its privileged
 * methods pin loopback for exactly this reason. Account/login state must
 * not be readable when someone binds dsh to 0.0.0.0.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LoginBusyError, type AccountService } from './account.js'
import type { Context } from './dsh-compat.js'

export interface RouteDeps {
  account: AccountService
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Register the `/omicos` prefix route. Returns disposers (caller owns effect wiring). */
export function registerOmicosRoutes(ctx: Context, deps: RouteDeps): Array<() => void> {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return []

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      json(res, 403, { error: 'loopback only' })
      return
    }
    const path = (req.url ?? '').split('?')[0]
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && path === '/omicos/account') {
        json(res, 200, await deps.account.snapshot())
        return
      }
      if (method === 'POST' && path === '/omicos/login/start') {
        const body = (await readJson(req)) as { method?: string } | undefined
        const requested = body?.method === 'wechat-qr' || body?.method === 'wechat' ? 'wechat-qr' : 'device-code'
        try {
          const begun = await deps.account.beginLogin(requested)
          json(res, 200, {
            method: begun.method,
            message: begun.message,
            qr_url: begun.qr_url,
            verification_uri: begun.verification_uri,
            user_code: begun.user_code,
          })
        } catch (err) {
          if (err instanceof LoginBusyError) {
            json(res, 409, { error: 'login already pending' })
            return
          }
          throw err
        }
        return
      }
      if (method === 'GET' && path === '/omicos/login/state') {
        json(res, 200, { pending: deps.account.loginPending, outcome: deps.account.loginOutcome })
        return
      }
      if (method === 'POST' && path === '/omicos/logout') {
        await deps.account.logout()
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: `no such omicos route: ${method} ${path}` })
    } catch (err) {
      json(res, 502, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  return [webServer.register({ kind: 'prefix', path: '/omicos', handler })]
}
