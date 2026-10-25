import {streamChat} from './chat-events.js'
import { DossierError } from './dossier-types.js'
import { AssemblyError } from './assembly-types.js'
import {publicationProfile} from './publication.js'
import { PublicationError } from './publication-types.js'
import { createHash } from 'node:crypto'
import { McpConnectionError } from './mcp-types.js'
import { builtinMethodPack } from './methods.js'
import { MethodError } from './method-types.js'
import { UploadError, UPLOAD_CHUNK_BYTES } from './upload-types.js'
import { EnvironmentError } from './environment-types.js'
import { ResearchPlanError } from './research-plan-types.js'
import { runtimeCapabilities } from './capabilities.js'
import { HistoryError, PROTOCOL_VERSION } from './types.js'
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
async function uploadChunkBody(request: IncomingMessage): Promise<Buffer> {
  if (request.headers['content-type'] !== 'application/octet-stream') throw new UploadError(415, 'Binary upload chunk required')
  if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > UPLOAD_CHUNK_BYTES) throw new UploadError(413, 'Upload chunks are limited to 4 MiB')
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { size += chunk.length; if (size > UPLOAD_CHUNK_BYTES) throw new UploadError(413, 'Upload chunks are limited to 4 MiB'); chunks.push(Buffer.from(chunk)) }
  return Buffer.concat(chunks)
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
      const data = method === 'POST' ? await body(request, /\/(notebook-(create|save)|pipeline-define|method-import)$/.test(path) ? 2_100_000 : 300_000) : undefined
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
        else if (action === 'executions' && method === 'GET') result = parent.historyFor(language, { before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, state: url.searchParams.get('state') || undefined, search: url.searchParams.get('q') || undefined })
        else if (action === 'execution' && method === 'GET') { const job = parent.receipt(url.searchParams.get('id') || ''); if (!job || job.language !== language) throw new AnnDataError(404, 'Project execution receipt not found'); result = job }
        else if (action === 'chat' || action === 'chat-send' || action === 'chat-cancel' || action === 'chat-events' || action === 'chat-history') {
          if (!runtime.chat) {
            if (action === 'chat' && method === 'GET') { sendJson(response, 200, { available: false, messages: [], reason: options.backend === 'core' ? '当前为 Core 兼容后端，请在 Harness 对话中使用原有委派工具；启用 OSS 后端后可连接项目专属 Scientist 会话。' : '从 DSH 的 OmicOS 入口打开工作台，即可连接科研 Agent。' }); return }
            throw new CloudError(503, '此工作台未连接 Harness 对话服务。请从 DSH 的 OmicOS 入口打开工作台；本地 Python 不受影响。')
          }
          if(action==='chat-events'&&method==='GET'){await streamChat(request,response,runtime.chat,project.workspace);return}
          const signal = AbortSignal.timeout(30000)
          if (action === 'chat' && method === 'GET') result = {...await runtime.chat.read(project.workspace, signal),streaming:!!runtime.chat.follow,history:!!runtime.chat.history}
          else if(action==='chat-history'&&method==='GET'){if(!runtime.chat.history)throw new CloudError(503,'Conversation history is unavailable');for(const key of ['through','before'])if(url.searchParams.has(key)&&(!/^\d+$/.test(url.searchParams.get(key)!)||!Number.isSafeInteger(Number(url.searchParams.get(key)))))throw new CloudError(400,'Invalid conversation history cursor');result=await runtime.chat.history(project.workspace,{throughSeq:url.searchParams.has('through')?Number(url.searchParams.get('through')):undefined,beforeSeq:url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined},signal)}
          else if (action === 'chat-send' && method === 'POST') result = await runtime.chat.send(project.workspace, String(data.text || ''), String(data.requestId || ''), signal)
          else if (action === 'chat-cancel' && method === 'POST') { await runtime.chat.cancel(project.workspace); result = { ok: true } }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action === 'environment' && method === 'GET') { if (language === 'python' && project.executionUnavailable) throw new EnvironmentError(409, project.executionUnavailable); result = language === 'r' ? await inspectREnvironment(runtime.rscript) : await inspectEnvironment(project.python, project.usesIsolatedPython) }
        else if(action?.startsWith('publication-profile-')){
          const profiles=await runtime.publicationProfiles(parent.workspace);const id=url.searchParams.get('id')||'';const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined;const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined
          if(action==='publication-profile-list'&&method==='GET'){const archived=url.searchParams.get('archived');if(archived!==null&&!['true','false'].includes(archived))throw new PublicationError(400,'Invalid archived filter');result=profiles.list(url.searchParams.get('q')||'',before,archived==='true')}
          else if(action==='publication-profile-document'&&method==='GET')result=profiles.get(id,revision)
          else if(action==='publication-profile-history'&&method==='GET')result=profiles.history(id,before)
          else if(action==='publication-profile-save'&&method==='POST'){if(data.confirmed!==true)throw new PublicationError(400,'Explicit publication profile save required; saving never authorizes export');result=await profiles.save(data.draft)}
          else throw new PublicationError(405,'Method not allowed')
        }
        else if(action?.startsWith('assembly-')){
          const assemblies=await runtime.assemblies(parent.workspace);const id=url.searchParams.get('id')||''
          const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined
          const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined
          if(action==='assembly-list'&&method==='GET')result=assemblies.list(url.searchParams.get('q')||'',before)
          else if(action==='assembly-document'&&method==='GET')result=assemblies.get(id,revision)
          else if(action==='assembly-history'&&method==='GET')result=assemblies.history(id,before)
          else if(action==='assembly-integrity'&&method==='GET')result=await assemblies.integrity(id,revision)
          else if(action==='assembly-manifest'&&method==='GET')result=assemblies.manifest(id,revision)
          else if(action==='assembly-save'&&method==='POST'){if(data.confirmed!==true)throw new AssemblyError(400,'Explicit figure layout/source capture required');result=await assemblies.save(data.assembly,'user:workbench')}
          else if(action==='assembly-review'&&method==='POST'){if(data.confirmed!==true)throw new AssemblyError(400,'Explicit human assembly review required');result=await assemblies.review(data.review)}
          else if(action==='assembly-pdf'&&method==='POST'){
            if(data.confirmed!==true)throw new PublicationError(400,'Explicit PDF font/physical-size/attachment export confirmation required')
            const profile=publicationProfile(data.profile);const cancel=new AbortController();const abort=()=>cancel.abort();response.once('close',abort)
            try{const bytes=await runtime.assemblyPdf(parent.workspace,id,revision,profile,cancel.signal,data.savedProfile);response.writeHead(200,{'content-type':'application/pdf','x-omicos-pdf-attachments':profile.attachments,'x-omicos-publication-profile':data.savedProfile?.digest||'none','x-content-type-options':'nosniff','content-disposition':'attachment; filename="omicos-assembly.pdf"','x-omicos-export-sha256':createHash('sha256').update(bytes).digest('hex')});response.end(bytes);return}finally{response.removeListener('close',abort)}
          }
          else if(action==='assembly-svg'&&method==='GET'){const bytes=await assemblies.svg(id,revision);response.writeHead(200,{'content-type':'application/octet-stream','x-content-type-options':'nosniff','content-disposition':'attachment; filename="omicos-assembly.svg"'});response.end(bytes);return}
          else throw new CloudError(405,'Method not allowed')
        }
        else if (action?.startsWith('mcp-')) {
          const connections = await runtime.mcpConnections(parent.workspace); const id = url.searchParams.get('id') || ''
          const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
          if (action === 'mcp-state' && method === 'GET') result = { connections:connections.list().connections.map(record=>({...record,authorized:connections.authorized(record)})), host: runtime.mcpHost ? await runtime.mcpHost.snapshot(parent.workspace) : { available:false,credentialEnvironmentNames:[],agents:[],scope:'Optional Harness project MCP adapter required; storing configurations never starts a server.' } }
          else if (action === 'mcp-document' && method === 'GET') result = connections.get(id,revision)
          else if (action === 'mcp-history' && method === 'GET') result = connections.history(id,before)
          else if (action === 'mcp-export' && method === 'GET') result = connections.export(id,revision)
          else if (['mcp-save','mcp-enabled','mcp-reconnect'].includes(action) && method === 'POST') {
            if (data.confirmed !== true) throw new McpConnectionError(400,'Explicit human MCP configuration/access decision required')
            result = action === 'mcp-save' ? await connections.save(data.connection) : action === 'mcp-enabled' ? await connections.setEnabled(data.decision) : await connections.reconnect(data.decision)
            await runtime.mcpHost?.reconcile(parent.workspace)
          } else throw new CloudError(405,'Method not allowed')
        }
        else if (action?.startsWith('dossier-')) {
          const dossier = await runtime.dossier(parent.workspace); const id = url.searchParams.get('id') || ''
          const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
          if (action === 'dossier-list' && method === 'GET') result = dossier.list(url.searchParams.get('q') || '',before)
          else if (action === 'dossier-document' && method === 'GET') result = dossier.get(id,revision)
          else if (action === 'dossier-history' && method === 'GET') result = dossier.history(id,before)
          else if (action === 'dossier-integrity' && method === 'GET') result = await dossier.integrity(id,revision)
          else if (action === 'dossier-export' && method === 'GET') result = dossier.export(id,revision)
          else if (action === 'dossier-save' && method === 'POST') { if (data.confirmed !== true) throw new DossierError(400,'Explicit evidence capture required'); result = await dossier.save(data.entry,'user:workbench') }
          else if (action === 'dossier-review' && method === 'POST') { if (data.confirmed !== true) throw new DossierError(400,'Explicit human dossier review required'); result = await dossier.review(data.review) }
          else throw new CloudError(405,'Method not allowed')
        }
        else if (action?.startsWith('method-')) {
          const methods = await runtime.methods(parent.workspace); const id = url.searchParams.get('id') || ''
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
          if (action === 'method-builtin-pack' && method === 'GET') result = builtinMethodPack()
          else if (action === 'method-list' && method === 'GET') result = methods.list(url.searchParams.get('q') || '', url.searchParams.get('state') || '', before)
          else if (action === 'method-document' && method === 'GET') result = methods.get(id)
          else if (action === 'method-reference' && method === 'GET') result = methods.reference(id)
          else if (action === 'method-history' && method === 'GET') result = methods.history(id, before)
          else if (action === 'method-export' && method === 'GET') result = methods.export(id)
          else if (action === 'method-import' && method === 'POST') { if (data.confirmed !== true) throw new MethodError(400, 'Explicit method pack import approval required'); result = await methods.importPack(data.pack, data.operationId, 'user:workbench') }
          else if (action === 'method-review' && method === 'POST') { if (data.confirmed !== true) throw new MethodError(400, 'Explicit human method publication/withdrawal required'); result = await methods.review(data.review) }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action?.startsWith('upload-')) {
          const uploads = await runtime.uploads(parent.workspace); const id = data?.id || url.searchParams.get('id') || ''
          if (action === 'upload-list' && method === 'GET') result = uploads.list(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
          else if (action === 'upload-document' && method === 'GET') result = uploads.get(id)
          else if (action === 'upload-start' && method === 'POST') { if (data.confirmed !== true) throw new UploadError(400, 'Explicit project file import approval required'); result = await uploads.start(data.upload) }
          else if (action === 'upload-chunk' && method === 'PUT') { const { chunkHashes, requestSha256, targetDirectory, targetDirectoryIdentity, ...summary } = await uploads.chunk(id, url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : NaN, await uploadChunkBody(request)); result = summary }
          else if (action === 'upload-finalize' && method === 'POST') { if (data.confirmed !== true) throw new UploadError(400, 'Explicit import publication required'); result = await uploads.finalize(id) }
          else if (action === 'upload-cancel' && method === 'POST') { if (data.confirmed !== true) throw new UploadError(400, 'Explicit partial import cancellation required'); result = await uploads.cancel(id) }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action?.startsWith('managed-environment-')) {
          const environments = await runtime.managedEnvironments(parent.workspace)
          if (action === 'managed-environment-list' && method === 'GET') result = { ...environments.list(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined), currentInterpreter: parent.python, currentUnavailable: parent.executionUnavailable }
          else if (action === 'managed-environment-document' && method === 'GET') result = environments.get(url.searchParams.get('id') || '')
          else if (action === 'managed-environment-history' && method === 'GET') result = environments.selectionHistory(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
          else if (action === 'managed-environment-install' && method === 'POST') { if (data.confirmed !== true) throw new EnvironmentError(400, 'Explicit package installation approval required'); result = environments.start(data.install) }
          else if (action === 'managed-environment-cancel' && method === 'POST') { if (data.confirmed !== true) throw new EnvironmentError(400, 'Explicit installation cancellation required'); result = await environments.cancel(data.id) }
          else if (action === 'managed-environment-remove' && method === 'POST') { if (data.confirmed !== true) throw new EnvironmentError(400, 'Explicit partial environment removal required'); result = await environments.removePartial(data.id) }
          else if (action === 'managed-environment-select' && method === 'POST') { if (data.confirmed !== true) throw new EnvironmentError(400, 'Explicit next-Host environment selection required'); result = await environments.select(data.selection) }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action?.startsWith('research-plan-')) {
          const plans = await runtime.researchPlans(parent.workspace); const id = url.searchParams.get('id') || ''
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
          if (action === 'research-plan-list' && method === 'GET') result = plans.list(url.searchParams.get('q') || '', before)
          else if (action === 'research-plan-document' && method === 'GET') result = plans.get(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined)
          else if (action === 'research-plan-history' && method === 'GET') result = plans.history(id, before)
          else if (action === 'research-plan-propose' && method === 'POST') result = await plans.propose(data.plan, 'user:workbench')
          else if (action === 'research-plan-decide' && method === 'POST') { if (data.confirmed !== true) throw new ResearchPlanError(400, 'Explicit human plan decision required'); result = await plans.decide(data.decision) }
          else throw new CloudError(405, 'Method not allowed')
        }
        else if (action === 'pipelines' || action?.startsWith('pipeline-')) {
          const pipelines = await runtime.pipelines(parent.workspace)
          const id = String(data?.runId || url.searchParams.get('run') || '')
          if (action === 'pipelines' && method === 'GET') result = pipelines.list({ definitionsBefore: url.searchParams.has('definitionsBefore') ? Number(url.searchParams.get('definitionsBefore')) : undefined, runsBefore: url.searchParams.has('runsBefore') ? Number(url.searchParams.get('runsBefore')) : undefined, definitionQuery: url.searchParams.get('definitionQuery') || undefined, runQuery: url.searchParams.get('runQuery') || undefined, state: url.searchParams.get('state') || undefined })
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
        else if (action === 'snapshot' && method === 'GET') result = project.snapshot()
        else if (action === 'execute' && method === 'POST') {
          if (data.confirmed !== true || typeof data.code !== 'string') throw new CloudError(400, 'Explicit execution approval required')
          result = await project.submit(data.code, String(data.operationId || ''), String(data.sessionId || 'workbench'))
        } else if (action === 'cancel' && method === 'POST') { await project.cancel(String(data.id)); result = { ok: true } }
        else if (action === 'memory' && method === 'POST') { await project.remember(String(data.id || ''), String(data.text || ''), String(data.source || ''), { owner: true, actor: 'user:workbench' }); result = { ok: true } }
        else if (action === 'notebook' && method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="omicos-analysis.ipynb"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          const write = async (chunk: string): Promise<boolean> => {
            if (response.destroyed) return false
            if (response.write(chunk)) return true
            if (response.destroyed || response.writableEnded) return false
            return new Promise(resolve => { const done = (okay: boolean) => { response.off('drain', drain); response.off('close', close); response.off('error', close); resolve(okay) }; const drain = () => done(true); const close = () => done(false); response.once('drain', drain); response.once('close', close); response.once('error', close) })
          }
          if (!await write(JSON.stringify(project.notebookHeader()).slice(0, -1) + ',"cells":[')) return
          let first = true
          for (const cell of project.notebookCells()) { if (!await write((first ? '' : ',') + JSON.stringify(cell))) return; first = false }
          response.end(']}'); return
        } else if (action === 'artifact' && method === 'GET') {
          const artifact = project.artifact(url.searchParams.get('id') || '', url.searchParams.get('execution') || undefined)
          if (!artifact) throw new CloudError(404, 'Artifact not found')
          const bytes = await artifactBytes(project.workspace, artifact)
          sendArtifact(response, { bytes, mime: artifact.mime }); return
        } else throw new CloudError(404, 'Unknown project operation')
      } else throw new CloudError(404, 'Unknown OmicOS OSS route')
      sendJson(response, 200, result)
    } catch (error) {
      if (response.writableEnded) return
      if (response.headersSent) { response.destroy(); return }
      sendJson(response, error instanceof CloudError || error instanceof NotebookError || error instanceof PipelineError || error instanceof MemoryError || error instanceof FigureError || error instanceof AnnDataError || error instanceof AssemblyError || error instanceof PublicationError || error instanceof McpConnectionError || error instanceof DossierError || error instanceof MethodError || error instanceof UploadError || error instanceof EnvironmentError || error instanceof ResearchPlanError || error instanceof HistoryError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
