import { runtimeCapabilities } from './capabilities.js'
import { PROTOCOL_VERSION } from './types.js'
import { FigureError } from './figure-types.js'
import { artifactBytes } from './artifact-bytes.js'
import { MemoryError } from './memory-types.js'
import { PipelineError } from './pipeline-types.js'
import { NotebookError } from './notebooks.js'
import type { HttpOwnerAuth } from './http-auth.js'
import { streamScientificEvents } from './events.js'
import { listWorkspace, previewWorkspaceFile } from './files.js'
import { AnnDataError, inspectAnnDataCode, plotAnnDataCode } from './anndata.js'
import { inspectEnvironment, inspectREnvironment } from './environment.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CloudError } from './cloud.js'
import type { OssRuntime } from './runtime.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
async function body(request: IncomingMessage, limit = 300_000): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new CloudError(415, 'JSON content type required')
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new CloudError(413, 'Request too large'); chunks.push(Buffer.from(chunk)) }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new CloudError(400, 'Invalid JSON') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CloudError(400, 'JSON object required')
  return parsed
}
function sendArtifact(response: ServerResponse, artifact: { bytes: Buffer; mime: string }): void {
  const raster = artifact.mime === 'image/png' || artifact.mime === 'image/jpeg'
  response.writeHead(200, { 'content-type': raster ? artifact.mime : 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...(raster ? {} : { 'content-disposition': `attachment; filename="omicos-artifact.${artifact.mime === 'application/pdf' ? 'pdf' : artifact.mime === 'image/svg+xml' ? 'svg' : 'bin'}"` }) })
  response.end(artifact.bytes)
}
/** Loopback + Host + same-origin + per-process CSRF nonce. No permissive CORS. */
export function createOssHandler(runtime: OssRuntime, auth: HttpOwnerAuth, options: { backend?: 'oss' | 'core' } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const nonce = randomUUID()
  return async (request, response) => {
    try {
      const host = request.headers.host || ''
      const scheme = 'encrypted' in request.socket && request.socket.encrypted === true ? 'https' : 'http'
      const url = new URL(request.url || '/', `${scheme}://${host}`)
      if (!LOOPBACK.has(request.socket.remoteAddress || '') || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || host !== url.host) throw new CloudError(403, 'Local Host only')
      if (request.headers.origin && request.headers.origin !== url.origin) throw new CloudError(403, 'Cross-origin access denied')
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new CloudError(403, 'Cross-site access denied')
      const path = url.pathname.replace(/\/$/, '')
      const method = request.method || 'GET'
      const page = method === 'GET' && (path === '/omicos/oss' || path === '/omicos/oss/store')
      if (page) { if (!auth.authorizePage(request, response)) return }
      else { const rejected = auth.requestRejection(request); if (rejected !== undefined) { sendJson(response, rejected, { error: 'Local owner authentication required' }); return } }
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
      if (method === 'GET' && path === '/omicos/oss/api/capabilities') { sendJson(response, 200, runtimeCapabilities(runtime, options.backend)); return }
      const requestedProtocol = request.headers['x-omicos-protocol']
      if (path.startsWith('/omicos/oss/api/') && requestedProtocol !== undefined && requestedProtocol !== String(PROTOCOL_VERSION)) { sendJson(response, 426, { error: 'Unsupported OmicOS scientific protocol; inspect capabilities before retrying', protocol: PROTOCOL_VERSION }); return }
      if (method === 'GET' && path === '/omicos/oss/api/session') {
        sendJson(response, 200, { csrf: nonce, backend: options.backend || 'oss', account: runtime.cloud.snapshot(), projects: await runtime.list(), protocol: PROTOCOL_VERSION }); return
      }
      if (method !== 'GET' && request.headers['x-omicos-csrf'] !== nonce) throw new CloudError(403, 'Invalid CSRF token')
      const data = method === 'POST' ? await body(request, /\/(notebook-(create|save)|pipeline-define)$/.test(path) ? 2_100_000 : 300_000) : undefined
      const cloud = runtime.cloud
      if (method === 'POST' && path.startsWith('/omicos/oss/api/') && !path.startsWith('/omicos/oss/api/project/') && path !== '/omicos/oss/api/open-session-project' && request.headers['x-omicos-account'] !== encodeURIComponent(cloud.identity())) throw new CloudError(409, 'Cloud account changed; refresh before submitting')
      let result: unknown
      if (path === '/omicos/oss/api/open-session-project' && method === 'POST') {
        if (!runtime.resolveSessionWorkspace) throw new CloudError(503, 'Harness workspace service is unavailable')
        if (typeof data.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.sessionId)) throw new CloudError(400, 'Invalid session identity')
        const workspace = await runtime.resolveSessionWorkspace(data.sessionId, AbortSignal.timeout(20000))
        const project = await runtime.project(workspace)
        result = (await runtime.list()).find(item => item.workspace === project.workspace)
      }
      else if (path === '/omicos/oss/api/login' && method === 'POST') result = await cloud.beginLogin()
      else if (path === '/omicos/oss/api/login/poll' && method === 'POST') result = await cloud.pollLogin()
      else if (path === '/omicos/oss/api/logout' && method === 'POST') { await cloud.logout(); result = cloud.snapshot() }
      else if (path === '/omicos/oss/api/plans' && method === 'GET') result = await cloud.plans(url.searchParams.get('domain') || '')
      else if (path === '/omicos/oss/api/subscription' && method === 'GET') result = await cloud.subscription(url.searchParams.get('domain') || '')
      else if (path === '/omicos/oss/api/subscriptions' && method === 'GET') result = await cloud.subscriptions()
      else if (path === '/omicos/oss/api/quote' && method === 'POST') result = await cloud.quote(data)
      else if (path === '/omicos/oss/api/checkout' && method === 'POST') result = await cloud.checkout(String(data.confirmation || ''))
      else if (path === '/omicos/oss/api/orders' && method === 'GET') result = await cloud.localOrders(url.searchParams.get('before') || undefined)
      else if (path === '/omicos/oss/api/order/reopen' && method === 'GET') result = await cloud.reopenOrder(url.searchParams.get('id') || '')
      else if (path === '/omicos/oss/api/order' && method === 'GET') result = await cloud.order(url.searchParams.get('id') || '')
      else if (path === '/omicos/oss/api/labs' && method === 'GET') result = await cloud.labs()
      else if (path === '/omicos/oss/api/lab-pricing' && method === 'GET') result = await cloud.labPricing()
      else if (path === '/omicos/oss/api/invoicing' && method === 'GET') result = await cloud.invoicing()
      else if (path === '/omicos/oss/api/invoice' && method === 'POST') {
        if (data.confirmed !== true) throw new CloudError(400, 'Explicit invoice confirmation required')
        result = await cloud.requestInvoice(data.invoice)
      }
      else if (path === '/omicos/oss/api/invoice/withdraw' && method === 'POST') {
        if (data.confirmed !== true) throw new CloudError(400, 'Explicit withdrawal confirmation required')
        result = await cloud.withdrawInvoice(String(data.id || ''))
      }
      else if (path === '/omicos/oss/api/lab/seats' && method === 'POST') {
        if (data.confirmed !== true) throw new CloudError(400, 'Explicit seat change confirmation required')
        result = await cloud.changeLabSeats(String(data.labId || ''), data.seats, String(data.provider || ''))
      }
      else if (path === '/omicos/oss/api/reminders' && method === 'GET') result = await cloud.reminders()
      else if (path === '/omicos/oss/api/subscription/manage' && method === 'POST') {
        if (!['cancel', 'uncancel'].includes(data.action) || data.confirmed !== true) throw new CloudError(400, 'Explicit subscription action confirmation required')
        result = await cloud.manageSubscription(data.action, data.domain)
      } else if (path.startsWith('/omicos/oss/api/project/')) {
        const parts = path.slice('/omicos/oss/api/project/'.length).split('/')
        const parent = await runtime.byId(parts[0] || '')
        const action = parts[1]
        const language = data?.language ?? url.searchParams.get('language') ?? 'python'
        if (!['python', 'r'].includes(language)) throw new CloudError(400, 'Unsupported scientific language')
        const project = language === 'r' && ['snapshot', 'execute', 'cancel', 'notebook', 'artifact'].includes(action || '') ? await runtime.rProject(parent.workspace) : parent
        if (action === 'events' && method === 'GET') {
          const last = request.headers['last-event-id']
          const after = Number(typeof last === 'string' && last !== '' ? last : url.searchParams.get('after') || '0')
          if (!Number.isSafeInteger(after) || after < 0) throw new CloudError(400, 'Invalid event cursor')
          streamScientificEvents(request, response, parent, after); return
        }
        else if (action === 'event-log' && method === 'GET') result = { cursor: parent.eventCursor, events: parent.events(Number(url.searchParams.get('after') || 0)) }
        else if (action === 'files' && method === 'GET') result = await listWorkspace(parent.workspace, url.searchParams.get('path') || '', runtime.sensitiveFiles)
        else if (action === 'file-preview' && method === 'GET') result = await previewWorkspaceFile(parent.workspace, url.searchParams.get('path') || '', runtime.sensitiveFiles)
        else if (action === 'anndata' && method === 'POST') {
          if (language !== 'python') throw new AnnDataError(400, 'AnnData inspection uses the Python kernel')
          if (data.confirmed !== true) throw new CloudError(400, 'Explicit inspection approval required')
          result = await parent.submit(inspectAnnDataCode(String(data.variable || '')), String(data.operationId || ''), 'workbench:anndata-inspection')
        }
        else if (action === 'anndata-plot' && method === 'POST') {
          if (language !== 'python') throw new AnnDataError(400, 'AnnData plotting uses the Python kernel')
          if (data.confirmed !== true) throw new AnnDataError(400, 'Explicit AnnData plotting approval required')
          if (data.expectedGeneration !== undefined && (typeof data.expectedGeneration !== 'string' || !/^[a-f0-9-]{36}$/.test(data.expectedGeneration))) throw new AnnDataError(400, 'Invalid expected kernel generation')
          result = await parent.submit(plotAnnDataCode(data.settings), String(data.operationId || ''), 'workbench:anndata-plot', data.expectedGeneration)
        }
        else if (action === 'execution' && method === 'GET') { const job = parent.receipt(url.searchParams.get('id') || ''); if (!job || job.language !== language) throw new AnnDataError(404, 'Project execution receipt not found'); result = job }
        else if (action === 'chat' || action === 'chat-send' || action === 'chat-cancel') {
          if (!runtime.chat) {
            if (action === 'chat' && method === 'GET') { sendJson(response, 200, { available: false, messages: [], reason: options.backend === 'core' ? '当前为 Core 兼容后端，请在 Harness 对话中使用原有委派工具；启用 OSS 后端后可连接项目专属 Scientist 会话。' : '从 DSH 的 OmicOS 入口打开工作台，即可连接科研 Agent。' }); return }
            throw new CloudError(503, '此工作台未连接 Harness 对话服务。请从 DSH 的 OmicOS 入口打开工作台；本地 Python 不受影响。')
          }
          const signal = AbortSignal.timeout(30000)
          if (action === 'chat' && method === 'GET') result = await runtime.chat.read(project.workspace, signal)
          else if (action === 'chat-send' && method === 'POST') result = await runtime.chat.send(project.workspace, String(data.text || ''), String(data.requestId || ''), signal)
          else if (action === 'chat-cancel' && method === 'POST') { await runtime.chat.cancel(project.workspace); result = { ok: true } }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action === 'environment' && method === 'GET') result = language === 'r' ? await inspectREnvironment(runtime.rscript) : await inspectEnvironment(project.python)
        else if (action === 'pipelines' || action?.startsWith('pipeline-')) {
          const pipelines = await runtime.pipelines(parent.workspace)
          const id = String(data?.runId || url.searchParams.get('run') || '')
          if (action === 'pipelines' && method === 'GET') result = pipelines.list()
          else if (action === 'pipeline-definition' && method === 'GET') result = pipelines.store.definition(url.searchParams.get('id') || '')
          else if (action === 'pipeline-define' && method === 'POST') result = pipelines.define(data.definition)
          else if (action === 'pipeline-start' && method === 'POST') {
            if (data.confirmed !== true) throw new CloudError(400, 'Explicit Pipeline execution approval required')
            result = pipelines.start(String(data.definitionId || ''), String(data.operationId || ''))
          }
          else if (action === 'pipeline-control' && method === 'POST') {
            if (data.confirmed !== true) throw new CloudError(400, 'Explicit Pipeline control/recovery approval required')
            result = await pipelines.control(id, data.revision, data.action, { checkpointAttemptId: data.checkpointAttemptId, sideEffectsReviewed: data.sideEffectsReviewed, allowEnvironmentChange: data.allowEnvironmentChange })
          }
          else if (action === 'pipeline-run' && method === 'GET') result = pipelines.get(id)
          else if (action === 'pipeline-events' && method === 'GET') result = { events: pipelines.store.events(id, Number(url.searchParams.get('after') || 0)) }
          else if (action === 'pipeline-execution' && method === 'GET') result = await pipelines.execution(id, url.searchParams.get('execution') || '')
          else if (action === 'pipeline-artifact' && method === 'GET') {
            const artifact = await pipelines.artifact(id, url.searchParams.get('execution') || '', url.searchParams.get('id') || '')
            sendArtifact(response, artifact); return
          }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action === 'figure-candidates' && method === 'GET') {
          const kind = url.searchParams.get('kind') || 'project'; if (!['project', 'pipeline'].includes(kind)) throw new FigureError(400, 'Unsupported figure source kind')
          result = kind === 'pipeline' ? (await runtime.pipelines(parent.workspace)).store.figureCandidates(url.searchParams.get('before') || undefined) : parent.figureCandidates(url.searchParams.get('before') || undefined)
        }
        else if (action?.startsWith('figure-')) {
          const figures = await runtime.figures(parent.workspace); const id = String(data?.id || url.searchParams.get('id') || '')
          const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined
          if (action === 'figure-list' && method === 'GET') result = figures.list(url.searchParams.get('q') || '', url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
          else if (action === 'figure-document' && method === 'GET') result = figures.get(id, revision)
          else if (action === 'figure-integrity' && method === 'GET') result = await figures.integrity(id, revision)
          else if (action === 'figure-history' && method === 'GET') result = figures.history(id, url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
          else if (action === 'figure-save' && method === 'POST') result = await figures.save(data.figure, 'user:workbench')
          else if (action === 'figure-review' && method === 'POST') { if (data.confirmed !== true) throw new FigureError(400, 'Explicit figure review confirmation required'); result = await figures.review(data.review, 'user:workbench') }
          else if (action === 'figure-manifest' && method === 'GET') { response.setHeader('content-disposition', 'attachment; filename="omicos-figure.json"'); result = figures.manifest(id, revision) }
          else if (action === 'figure-artifact' && method === 'GET') { const artifact = await figures.artifact(id, revision); response.writeHead(200, { 'content-type': artifact.mime === 'image/png' || artifact.mime === 'image/jpeg' ? artifact.mime : 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="omicos-figure.${artifact.mime === 'application/pdf' ? 'pdf' : artifact.mime === 'image/svg+xml' ? 'svg' : artifact.mime === 'image/jpeg' ? 'jpg' : 'png'}"` }); response.end(artifact.bytes); return }
          else throw new FigureError(405, 'Method not allowed')
        }
        else if (action === 'memory-tree' && method === 'GET') result = parent.memory.summaryList({ owner: true }, { search: url.searchParams.get('q') || '', ...(url.searchParams.has('parent') ? { parentId: url.searchParams.get('parent') === 'root' ? null : url.searchParams.get('parent') } : {}), before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined })
        else if (action === 'memory-node' && method === 'GET') result = url.searchParams.has('revision') ? { node: parent.memory.get(url.searchParams.get('id') || '', { owner: true }, Number(url.searchParams.get('revision'))), historical: true } : parent.memory.view(url.searchParams.get('id') || '', { owner: true })
        else if (action === 'memory-history' && method === 'GET') result = parent.memory.history(url.searchParams.get('id') || '', { owner: true }, url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
        else if (action === 'memory-context' && method === 'GET') result = parent.memory.context({ sessionId: url.searchParams.get('session') || undefined })
        else if (action === 'memory-propose' && method === 'POST') result = parent.memory.propose(data.entry, { owner: true, actor: 'user:workbench' })
        else if (action === 'memory-transition' && method === 'POST') {
          if (data.confirmed !== true) throw new CloudError(400, 'Explicit memory revision approval required')
          result = parent.memory.transition(data.change, { owner: true, actor: 'user:workbench' })
        }
        else if (action === 'notebooks' && method === 'GET') result = { notebooks: parent.notebooks.list() }
        else if (action === 'notebook-document' && method === 'GET') result = parent.notebooks.get(url.searchParams.get('id') || '')
        else if (action === 'notebook-create' && method === 'POST') result = await parent.notebooks.create(data.title, language, data.imported)
        else if (action === 'notebook-save' && method === 'POST') result = await parent.notebooks.save(data.id, data.revision, data.title, data.cells)
        else if (action === 'notebook-run' && method === 'POST') {
          if (data.confirmed !== true) throw new CloudError(400, 'Explicit cell execution approval required')
          result = await parent.notebooks.run(data.id, data.revision, data.cellId, String(data.operationId || ''), async (language, source, operation, session) => {
            const kernel = language === 'r' ? await runtime.rProject(parent.workspace) : parent
            return kernel.submit(source, operation, session)
          })
        }
        else if (action === 'notebook-download' && method === 'GET') {
          const document = parent.notebooks.get(url.searchParams.get('id') || '')
          const kernel = document.language === 'r' ? await runtime.rProject(parent.workspace) : parent
          response.setHeader('content-disposition', 'attachment; filename="omicos-notebook.ipynb"')
          result = parent.notebooks.export(document.id, (_language, id) => kernel.get(id))
        }
        else if (action === 'snapshot' && method === 'GET') result = { ...project.snapshot(), memories: parent.snapshot().memories }
        else if (action === 'execute' && method === 'POST') {
          if (data.confirmed !== true || typeof data.code !== 'string') throw new CloudError(400, 'Explicit execution approval required')
          result = await project.submit(data.code, String(data.operationId || ''), String(data.sessionId || 'workbench'))
        } else if (action === 'cancel' && method === 'POST') { await project.cancel(String(data.id)); result = { ok: true } }
        else if (action === 'memory' && method === 'POST') { await project.remember(String(data.id || ''), String(data.text || ''), String(data.source || ''), { owner: true, actor: 'user:workbench' }); result = { ok: true } }
        else if (action === 'notebook' && method === 'GET') {
          response.setHeader('content-disposition', 'attachment; filename="omicos-analysis.ipynb"'); result = project.notebook()
        } else if (action === 'artifact' && method === 'GET') {
          const artifact = project.snapshot().executions.flatMap(job => job.artifacts).find(item => item.id === url.searchParams.get('id'))
          if (!artifact) throw new CloudError(404, 'Artifact not found')
          const bytes = await artifactBytes(project.workspace, artifact)
          sendArtifact(response, { bytes, mime: artifact.mime }); return
        } else throw new CloudError(404, 'Unknown project operation')
      } else throw new CloudError(404, 'Unknown OmicOS OSS route')
      sendJson(response, 200, result)
    } catch (error) {
      if (response.writableEnded) return
      sendJson(response, error instanceof CloudError || error instanceof NotebookError || error instanceof PipelineError || error instanceof MemoryError || error instanceof FigureError || error instanceof AnnDataError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
