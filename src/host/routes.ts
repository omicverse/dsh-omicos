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
import { classifyGeneratedFile, fetchFilePreview } from '@omicverse/omicos-client'
import { LoginBusyError, type AccountService } from './account.js'
import type { ActivityStore } from './activity-store.js'
import type { OmicosPool } from './pool.js'
import type { Context } from './dsh-compat.js'

export interface RouteDeps {
  account: AccountService
  /** Live-activity feed for GET /omicos/activity/<callId> (v0.2 toolview). */
  activity?: ActivityStore
  /** Figure byte proxy for GET /omicos/figure?ws=&path= (settled toolview cards). */
  pool?: OmicosPool
}

/**
 * Containment for the figure proxy (DSH-PLUGIN.md §7): only workspace-
 * relative image paths, no traversal, no absolute paths — the route
 * exists to re-serve files core itself reported in `generated_files`.
 */
function safeFigurePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false
  return classifyGeneratedFile(path).kind === 'image'
}

/** Extensions the files-tab preview route will serve (same containment shape as figures, wider types). */
const PREVIEWABLE_EXT = /\.(png|jpe?g|gif|webp|pdf|csv|tsv|txt|json|md|log|yaml|yml)$/i
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024

function safePreviewPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false
  return PREVIEWABLE_EXT.test(path)
}

/** Sniff-safe content type for the preview route: real types for embeddable media, text/plain for everything textual. */
function previewContentType(path: string): string {
  const { kind, mimeType } = classifyGeneratedFile(path)
  if (kind === 'image') return mimeType
  if (kind === 'pdf' || /\.pdf$/i.test(path)) return 'application/pdf'
  return 'text/plain; charset=utf-8'
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
      if (method === 'GET' && path.startsWith('/omicos/activity/')) {
        const callId = decodeURIComponent(path.slice('/omicos/activity/'.length))
        const feed = deps.activity?.get(callId)
        if (feed === undefined) {
          json(res, 404, { error: 'no live activity for this call (host restarted or feed expired)' })
          return
        }
        json(res, 200, { running: feed.running, snapshot: feed.snapshot })
        return
      }
      if (method === 'GET' && path.startsWith('/omicos/files/')) {
        // The dsh session's generated files + owning workspace. Fast path:
        // probe warm pool entries (undefined = that kernel has no such
        // conversation). Cold path (host restarted, pool empty): resolve the
        // session's workspace from dsh's own ledger (`SessionHeader.cwd`)
        // and let `pool.entry(cwd)` attach-or-spawn.
        const dshSessionId = decodeURIComponent(path.slice('/omicos/files/'.length))
        if (deps.pool === undefined) {
          json(res, 404, { error: 'no kernel pool' })
          return
        }
        for (const entry of deps.pool.list()) {
          try {
            const files = await entry.runner.filesIfExists(dshSessionId)
            if (files !== undefined) {
              json(res, 200, { workspace: entry.workspace, files })
              return
            }
          } catch {
            // unreachable kernel; try the next entry
          }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const headers = (await persistence.list()) as Array<{ id: string; cwd?: string }>
          const cwd = headers.find((h) => String(h.id) === dshSessionId)?.cwd
          if (cwd !== undefined && cwd !== '') {
            const entry = deps.pool.entry(cwd)
            const files = await entry.runner.filesIfExists(dshSessionId)
            json(res, 200, { workspace: cwd, files: files ?? [] })
            return
          }
        }
        json(res, 404, { error: 'no omicos conversation for this session yet' })
        return
      }
      if (method === 'GET' && path === '/omicos/file') {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
        const ws = query.get('ws') ?? ''
        const filePath = query.get('path') ?? ''
        if (deps.pool === undefined || ws === '' || !safePreviewPath(filePath)) {
          json(res, 400, { error: 'file route needs ws + a workspace-relative previewable path' })
          return
        }
        const handle = await deps.pool.entry(ws).kernel.handle()
        const preview = await fetchFilePreview(handle.baseUrl, filePath)
        if (preview.bytes.byteLength > PREVIEW_MAX_BYTES) {
          json(res, 413, { error: 'file too large for inline preview' })
          return
        }
        res.writeHead(200, {
          'content-type': previewContentType(filePath),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        res.end(Buffer.from(preview.bytes))
        return
      }
      if (method === 'GET' && path === '/omicos/figure') {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
        const ws = query.get('ws') ?? ''
        const figurePath = query.get('path') ?? ''
        if (deps.pool === undefined || ws === '' || !safeFigurePath(figurePath)) {
          json(res, 400, { error: 'figure route needs ws + a workspace-relative image path' })
          return
        }
        const handle = await deps.pool.entry(ws).kernel.handle()
        const preview = await fetchFilePreview(handle.baseUrl, figurePath)
        res.writeHead(200, { 'content-type': preview.contentType, 'cache-control': 'no-store' })
        res.end(Buffer.from(preview.bytes))
        return
      }
      json(res, 404, { error: `no such omicos route: ${method} ${path}` })
    } catch (err) {
      json(res, 502, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  return [webServer.register({ kind: 'prefix', path: '/omicos', handler })]
}
