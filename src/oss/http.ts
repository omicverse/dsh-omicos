import { inspectEnvironment } from './environment.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CloudError } from './cloud.js'
import type { OssRuntime } from './runtime.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
async function body(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new CloudError(415, 'JSON content type required')
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { size += chunk.length; if (size > 300_000) throw new CloudError(413, 'Request too large'); chunks.push(Buffer.from(chunk)) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new CloudError(400, 'Invalid JSON') }
}
/** Loopback + Host + same-origin + per-process CSRF nonce. No permissive CORS. */
export function createOssHandler(runtime: OssRuntime): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const nonce = randomUUID()
  return async (request, response) => {
    try {
      const host = request.headers.host || ''
      const url = new URL(request.url || '/', `http://${host}`)
      if (!LOOPBACK.has(request.socket.remoteAddress || '') || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || host !== url.host) throw new CloudError(403, 'Local Host only')
      if (request.headers.origin && request.headers.origin !== url.origin) throw new CloudError(403, 'Cross-origin access denied')
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new CloudError(403, 'Cross-site access denied')
      const path = url.pathname.replace(/\/$/, '')
      const method = request.method || 'GET'
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      if (method === 'GET' && (path === '/omicos/oss' || path === '/omicos/oss/store')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'referrer-policy': 'no-referrer' })
        response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OmicOS OSS</title><link rel="stylesheet" href="/omicos/oss/workbench.css"></head><body><div id="root"></div><script src="/omicos/oss/workbench.js" defer></script></body></html>')
        return
      }
      if (method === 'GET' && /^\/omicos\/oss\/workbench\.(js|css)$/.test(path)) {
        const extension = path.endsWith('.js') ? 'js' : 'css'
        const asset = await readFile(fileURLToPath(new URL(`../workbench.${extension}`, import.meta.url)))
        response.writeHead(200, { 'content-type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); response.end(asset); return
      }
      if (method === 'GET' && path === '/omicos/oss/api/session') {
        sendJson(response, 200, { csrf: nonce, account: runtime.cloud.snapshot(), projects: await runtime.list(), protocol: 1 }); return
      }
      if (method !== 'GET' && request.headers['x-omicos-csrf'] !== nonce) throw new CloudError(403, 'Invalid CSRF token')
      const data = method === 'POST' ? await body(request) : undefined
      const cloud = runtime.cloud
      let result: unknown
      if (path === '/omicos/oss/api/login' && method === 'POST') result = await cloud.beginLogin()
      else if (path === '/omicos/oss/api/login/poll' && method === 'POST') result = await cloud.pollLogin()
      else if (path === '/omicos/oss/api/logout' && method === 'POST') { await cloud.logout(); result = cloud.snapshot() }
      else if (path === '/omicos/oss/api/plans' && method === 'GET') result = await cloud.plans(url.searchParams.get('domain') || '')
      else if (path === '/omicos/oss/api/subscription' && method === 'GET') result = await cloud.subscription(url.searchParams.get('domain') || '')
      else if (path === '/omicos/oss/api/subscriptions' && method === 'GET') result = await cloud.subscriptions()
      else if (path === '/omicos/oss/api/quote' && method === 'POST') result = await cloud.quote(data)
      else if (path === '/omicos/oss/api/checkout' && method === 'POST') result = await cloud.checkout(String(data.confirmation || ''))
      else if (path === '/omicos/oss/api/order' && method === 'GET') result = await cloud.order(url.searchParams.get('id') || '')
      else if (path === '/omicos/oss/api/lab-pricing' && method === 'GET') result = await cloud.labPricing()
      else if (path === '/omicos/oss/api/invoicing' && method === 'GET') result = await cloud.invoicing()
      else if (path === '/omicos/oss/api/reminders' && method === 'GET') result = await cloud.reminders()
      else if (path === '/omicos/oss/api/subscription/manage' && method === 'POST') {
        if (!['cancel', 'uncancel'].includes(data.action) || data.confirmed !== true) throw new CloudError(400, 'Explicit subscription action confirmation required')
        result = await cloud.manageSubscription(data.action, data.domain)
      } else if (path.startsWith('/omicos/oss/api/project/')) {
        const parts = path.slice('/omicos/oss/api/project/'.length).split('/')
        const project = await runtime.byId(parts[0] || '')
        const action = parts[1]
        if (action === 'environment' && method === 'GET') result = await inspectEnvironment(project.python)
        else if (action === 'snapshot' && method === 'GET') result = project.snapshot()
        else if (action === 'execute' && method === 'POST') {
          if (data.confirmed !== true || typeof data.code !== 'string') throw new CloudError(400, 'Explicit execution approval required')
          result = await project.submit(data.code, String(data.operationId || ''), String(data.sessionId || 'workbench'))
        } else if (action === 'cancel' && method === 'POST') { await project.cancel(String(data.id)); result = { ok: true } }
        else if (action === 'memory' && method === 'POST') { await project.remember(String(data.id || ''), String(data.text || ''), String(data.source || '')); result = { ok: true } }
        else if (action === 'notebook' && method === 'GET') {
          response.setHeader('content-disposition', 'attachment; filename="omicos-analysis.ipynb"'); result = project.notebook()
        } else if (action === 'artifact' && method === 'GET') {
          const artifact = project.snapshot().executions.flatMap(job => job.artifacts).find(item => item.id === url.searchParams.get('id'))
          if (!artifact) throw new CloudError(404, 'Artifact not found')
          const file = await realpath(join(project.workspace, artifact.path))
          if (!file.startsWith(project.workspace + sep)) throw new CloudError(403, 'Artifact outside workspace')
          const bytes = await readFile(file)
          if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new CloudError(409, 'Artifact changed since execution')
          response.writeHead(200, { 'content-type': artifact.mime === 'image/png' ? 'image/png' : 'application/octet-stream' }); response.end(bytes); return
        } else throw new CloudError(404, 'Unknown project operation')
      } else throw new CloudError(404, 'Unknown OmicOS OSS route')
      sendJson(response, 200, result)
    } catch (error) {
      if (response.writableEnded) return
      sendJson(response, error instanceof CloudError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
