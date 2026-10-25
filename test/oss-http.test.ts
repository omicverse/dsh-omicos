import {pdfAttachments} from './pdf-helpers.js'
import { ScienceLedger } from '../src/oss/ledger.js'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest, createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OssRuntime } from '../src/oss/runtime.js'
import { LocalOwnerAuth } from '../src/oss/http-auth.js'
import { createOssHandler } from '../src/oss/http.js'
import { CloudService } from '../src/oss/cloud.js'

const listen = (server: Server): Promise<string> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)))
const close = (server: Server): Promise<void> => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() })
describe('scientific workbench and commerce boundary', () => {
  let directory: string; let runtime: OssRuntime; let cloud: Server; let server: Server; let base: string; let owner: LocalOwnerAuth
  let approvals = false; let paid = false; let orders = 0; let csrf = ''; const seen: Array<{ path: string; body: any; authorization?: string }> = []
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'omicos-oss-http-'))
    approvals = false; paid = false; orders = 0; seen.length = 0
    cloud = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); const path = request.url!
      seen.push({ path, body, authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      if (path === '/api/auth/cli-device-code') response.end(JSON.stringify({ device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://app.omicos.cn/pair', expires_in: 300, interval: 2 }))
      else if (path === '/api/auth/cli-poll') response.end(JSON.stringify(approvals ? { status: 'approved', user_token: 'private-user-token', process_token: 'never-persist-this', user: { id: 'u1', email: 'test@example.invalid' } } : { status: 'pending' }))
      else if (path.startsWith('/api/plans')) response.end(JSON.stringify({ plans: [{ code: 'pro', name: 'Pro', monthly_price_rmb: 10, yearly_price_rmb: 100 }, { code: 'lab', name: 'Lab', monthly_price_rmb: null, yearly_price_rmb: null }] }))
      else if (!request.headers.authorization) { response.statusCode = 401; response.end('{}') }
      else if (path === '/api/billing/lab/pricing') response.end(JSON.stringify({ min_seats: 3, can_purchase: true, currency: 'CNY', seat_price_monthly_rmb: 8, seat_price_yearly_rmb: 80, grants_plan: 'pro' }))
      else if (path === '/api/labs') response.end(JSON.stringify({ labs: [{ id: 'lab_1', name: 'Test lab', owner_id: 'u1', seat_quota: 3, status: 'active' }] }))
      else if (path === '/api/billing/lab/lab_1/seats') response.end(JSON.stringify({ message: 'updated', new_total_seats: body.seats }))
      else if (path === '/api/billing/invoicing') response.end(JSON.stringify({ paid_cents: 1000, remaining_cents: 1000, invoiced_cents: 0, min_invoice_cents: 500, daily_limit: 5, submitted_today: 0, orders: [{ order_no: 'ord_1', amount_rmb_cents: 1000, invoiced: false }], invoices: [] }))
      else if (path === '/api/billing/invoicing/invoices') response.end(JSON.stringify({ invoice_id: 'inv_1', status: 'pending' }))
      else if (path === '/api/billing/invoicing/invoices/inv_1/withdraw') response.end(JSON.stringify({ invoice_id: 'inv_1', status: 'voided' }))
      else if (path === '/api/billing/checkout') { orders++; response.end(JSON.stringify({ order_no: `ord_${orders}`, amount_rmb: 10, currency: 'CNY', pay_url: 'weixin://wxpay/bizpayurl?pr=example', provider: body.provider, expires_at: '2099-01-01' })) }
      else if (path.startsWith('/api/billing/orders/')) response.end(JSON.stringify({ order_no: 'ord_1', status: paid ? 'paid' : 'pending', amount_rmb_cents: 1000, provider: 'wechat', expires_at: '2099-01-01' }))
      else if (path === '/api/billing/subscriptions') response.end(JSON.stringify({ subscriptions: [{ domain: 'omics', plan_code: 'pro', expires_at: '2099-01-01', auto_renew: 0, kind: 'annual' }, { domain: 'humanities_social', plan_code: 'plus', expires_at: '2099-01-01', auto_renew: 1, kind: 'trial' }] }))
      else if (path === '/api/billing/expiry-reminders') response.end(JSON.stringify({ reminders: [{ domain: 'humanities_social', plan_code: 'plus', expires_at: '2099-01-01', state: 'expiring_soon', days_left: 3, auto_renew: 0 }] }))
      else if (path.startsWith('/api/billing/subscription')) response.end(JSON.stringify({ active: paid, domain: new URL(path, 'http://fixture.invalid').searchParams.get('domain') || 'omics', subscription: paid ? { plan_code: 'pro' } : undefined }))
      else { response.statusCode = 404; response.end('{}') }
    })
    const cloudBase = await listen(cloud)
    runtime = await OssRuntime.open({ cloudBase, stateDir: join(directory, 'state') })
    await runtime.project(join(directory, 'project'))
    owner = new LocalOwnerAuth(); server = createServer(createOssHandler(runtime, owner)); base = await listen(server)
    csrf = (await (await fetchHost(`${base}/omicos/oss/api/session`)).json() as any).csrf
  })
  afterEach(async () => { await close(server); await runtime.dispose(); await close(cloud); await rm(directory, { recursive: true, force: true }) })
  it('denies unauthenticated pages, assets, API snapshots, writes and event streams before exposing state', async () => {
    const project = (await runtime.project(directory)).id
    for (const path of ['', '/store', '/workbench.js', '/api/session', `/api/project/${project}/snapshot`, `/api/project/${project}/events`]) {
      expect((await globalThis.fetch(`${base}/omicos/oss${path}`)).status).toBe(401)
    }
    expect((await globalThis.fetch(`${base}/omicos/oss/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': csrf }, body: '{}' })).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  const fetchHost = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { authorization: `Bearer ${owner.launchToken}`, ...init.headers } })
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => fetchHost(`${base}/omicos/oss/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': csrf, 'x-omicos-account': encodeURIComponent(runtime.cloud.identity()), ...headers }, body: JSON.stringify(data) })
  const login = async () => { approvals = true; expect((await post('login', {})).status).toBe(200); expect((await post('login/poll', {})).status).toBe(200) }
  it('protects assembly source capture, human review and SVG downloads with owner/CSRF and exact revisions without execution',async()=>{
    const reference=(await runtime.list())[0];const project=await runtime.byId(reference.id);const prefix=`project/${reference.id}/`
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');const artifact={id:'assembly-png',path:'.omicos-oss/http-assembly.png',mime:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
    await writeFile(join(project.workspace,artifact.path),bytes)
    const ledger=await ScienceLedger.open(project.workspace);try{ledger.saveExecutions('python',[{id:'assembly-receipt',operationId:'assembly-fixture',sessionId:'fixture',language:'python',state:'succeeded',code:'fixture_plot()',output:'',artifacts:[artifact],createdAt:'2026-10-25'}])}finally{ledger.close()}
    const figure=await (await post(`${prefix}figure-save`,{figure:{title:'Original PNG',caption:'Fixture receipt',source:{kind:'project',language:'python',executionId:'assembly-receipt',artifactId:artifact.id},methods:[],dataReferences:[],operationId:'curate-assembly'}})).json() as any
    const approved=await (await post(`${prefix}figure-review`,{confirmed:true,review:{id:figure.id,revision:1,decision:'approved',note:'Fixture source review',operationId:'review-assembly-source'}})).json() as any
    const assembly={title:'HTTP assembly',caption:'No scientific re-execution',operationId:'assembly-save',layout:{width:600,height:400,panels:[{figureId:figure.id,figureRevision:approved.revision,x:10,y:10,width:580,height:380,label:'A'}]}}
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}assembly-list`)).status).toBe(401)
    expect((await post(`${prefix}assembly-save`,{assembly})).status).toBe(400)
    expect((await post(`${prefix}assembly-save`,{assembly,confirmed:true},{'x-omicos-csrf':''})).status).toBe(403)
    const saved=await (await post(`${prefix}assembly-save`,{assembly,confirmed:true})).json() as any;expect(saved.review.state).toBe('draft')
    const review={id:saved.id,revision:1,decision:'approved',note:'Checked source and layout',operationId:'review-assembly'}
    expect((await post(`${prefix}assembly-review`,{review})).status).toBe(400)
    expect((await post(`${prefix}assembly-review`,{review,confirmed:true})).status).toBe(200)
    const svg=await fetchHost(`${base}/omicos/oss/api/${prefix}assembly-svg?id=${saved.id}&revision=2`);expect(svg.headers.get('content-type')).toBe('application/octet-stream');expect(svg.headers.get('content-disposition')).toContain('.svg');expect(await svg.text()).toContain(bytes.toString('base64'))
    expect((await post(`${prefix}assembly-pdf?id=${saved.id}&revision=2`,{profile:{dpi:180}})).status).toBe(400)
    expect((await post(`${prefix}assembly-pdf?id=${saved.id}&revision=2`,{confirmed:true,profile:{dpi:180}},{'x-omicos-csrf':''})).status).toBe(403)
    const pdf=await post(`${prefix}assembly-pdf?id=${saved.id}&revision=2`,{confirmed:true,profile:{dpi:180}});expect(pdf.status).toBe(200);expect(pdf.headers.get('x-omicos-pdf-attachments')).toBe('provenance');expect(pdf.headers.get('content-type')).toBe('application/pdf');const pdfBytes=Buffer.from(await pdf.arrayBuffer());expect(pdfBytes.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.headers.get('x-omicos-export-sha256')).toBe(createHash('sha256').update(pdfBytes).digest('hex'))
    const profileDraft={name:'Paper export',description:'Reusable project settings',profile:{dpi:180,attachments:'none'},operationId:'http-profile'};expect((await post(`${prefix}publication-profile-save`,{draft:profileDraft})).status).toBe(400);expect((await post(`${prefix}publication-profile-save`,{confirmed:true,draft:profileDraft},{'x-omicos-csrf':''})).status).toBe(403);const preference=await (await post(`${prefix}publication-profile-save`,{confirmed:true,draft:profileDraft})).json() as any;const profileReference={id:preference.id,revision:preference.revision,digest:preference.digest};expect((await (await fetchHost(`${base}/omicos/oss/api/${prefix}publication-profile-list`)).json() as any).entries[0].id).toBe(preference.id);
    const plain=await post(`${prefix}assembly-pdf?id=${saved.id}&revision=2`,{confirmed:true,profile:{dpi:180,attachments:'none'},savedProfile:profileReference});expect(plain.status).toBe(200);expect(plain.headers.get('x-omicos-pdf-attachments')).toBe('none');expect(plain.headers.get('x-omicos-publication-profile')).toBe(preference.digest);expect((await pdfAttachments(Buffer.from(await plain.arrayBuffer()))).files.size).toBe(0)
    expect((await post(`${prefix}assembly-pdf?id=${saved.id}`,{confirmed:true,profile:{dpi:180,attachSources:false}})).status).toBe(400)
    expect((await post(`${prefix}assembly-pdf?id=${saved.id}`,{confirmed:true,profile:{dpi:300,attachments:'none'},savedProfile:profileReference})).status).toBe(409)
    const fullPreference=await (await post(`${prefix}publication-profile-save`,{confirmed:true,draft:{...profileDraft,profile:{dpi:180,attachments:'provenance'},operationId:'http-full-profile'}})).json() as any;const fullExport=await post(`${prefix}assembly-pdf?id=${saved.id}&revision=2`,{confirmed:true,profile:fullPreference.profile,savedProfile:{id:fullPreference.id,revision:1,digest:fullPreference.digest}});expect(fullExport.status).toBe(200);const attached=await pdfAttachments(Buffer.from(await fullExport.arrayBuffer()));expect(JSON.parse(attached.files.get('omicos-assembly-provenance.json')!.toString()).savedPublicationProfile.digest).toBe(fullPreference.digest)
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}assembly-svg?id=${saved.id}`)).status).toBe(401)
    const old=await (await fetchHost(`${base}/omicos/oss/api/${prefix}assembly-document?id=${saved.id}&revision=1`)).json() as any;expect(old.review.state).toBe('draft')
    expect((await (await fetchHost(`${base}/omicos/oss/api/${prefix}assembly-integrity?id=${saved.id}`)).json() as any).state).toBe('verified')
    expect((await (await fetchHost(`${base}/omicos/oss/api/${prefix}assembly-history?id=${saved.id}`)).json() as any).revisions).toHaveLength(2)
    expect(project.snapshot().executions).toEqual([]);expect(seen).toHaveLength(0)
  })
  it('keeps MCP management owner-only and human-confirmed, preserves revisions and does not activate servers in standalone mode',async()=>{
    const reference=(await runtime.list())[0];const prefix=`project/${reference.id}/mcp-`
    const connection={operationId:'mcp-create',title:'Local research extension',note:'Explicit configuration only',config:{transport:'stdio',serverName:'papers',command:'missing-server-executable',args:[],env:{API_TOKEN:{environment:'RESEARCH_TOKEN'}},toolCallTimeoutMs:5000}}
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}state`)).status).toBe(401)
    expect((await post(`${prefix}save`,{connection,confirmed:true},{'x-omicos-csrf':''})).status).toBe(403)
    expect((await post(`${prefix}save`,{connection})).status).toBe(400)
    const saved=await (await post(`${prefix}save`,{connection,confirmed:true})).json() as any;expect(saved.enabled).toBe(false)
    const decision={id:saved.id,revision:saved.revision,operationId:'mcp-enable',enabled:true,note:'Allow this project on a future Harness connection'}
    expect((await post(`${prefix}enabled`,{decision})).status).toBe(400)
    expect((await post(`${prefix}enabled`,{decision,confirmed:true})).status).toBe(200)
    const state=await (await fetchHost(`${base}/omicos/oss/api/${prefix}state`)).json() as any;expect(state.host.available).toBe(false);expect(state.connections[0].revision).toBe(2)
    const reconnect={id:saved.id,revision:2,operationId:'mcp-reconnect',note:'Explicit reconnect revision'}
    expect((await (await post(`${prefix}reconnect`,{decision:reconnect,confirmed:true})).json() as any).revision).toBe(3)
    expect((await (await post(`${prefix}reconnect`,{decision:reconnect,confirmed:true})).json() as any).revision).toBe(3)
    const exported=await (await fetchHost(`${base}/omicos/oss/api/${prefix}export?id=${saved.id}&revision=2`)).json() as any;expect(exported.enabled).toBe(false);expect(exported.origin.revision).toBe(2);expect(exported.connection.config.env.API_TOKEN).toEqual({environment:'RESEARCH_TOKEN'})
    expect((await (await fetchHost(`${base}/omicos/oss/api/${prefix}history?id=${saved.id}`)).json() as any).revisions).toHaveLength(3)
    expect((await (await runtime.byId(reference.id)).snapshot()).executions).toEqual([]);expect(seen).toHaveLength(0)
  })
  it('blocks cross-origin, DNS rebinding and unauthenticated mutations', async () => {
    expect((await post('logout', {}, { origin: 'https://attacker.invalid' })).status).toBe(403)
    expect((await post('logout', {}, { 'x-omicos-csrf': '' })).status).toBe(403)
    const rebinding = await new Promise<number | undefined>(resolve => { const request = httpRequest(`${base}/omicos/oss/api/session`, { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode) }); request.end() })
    expect(rebinding).toBe(403)
    const projects = await runtime.list()
    expect((await post(`project/${projects[0].id}/execute`, { code: 'print(1)', operationId: 'x' })).status).toBe(400)
  })
  it('exposes revisioned memory only to the owner, requires confirmation and scopes automatic context', async () => {
    const project = (await runtime.list())[0].id; const route = `project/${project}/`
    const response = await post(`${route}memory-propose`, { entry: { title: 'Private reference', text: 'GRCh38-private', kind: 'fact', scope: 'session', sessionId: 'fixture-session', sources: [{ kind: 'user', ref: 'researcher' }], operationId: 'memory-proposal' } })
    expect(response.status).toBe(200); const proposed = await response.json() as any
    const change = { id: proposed.id, revision: proposed.revision, action: 'confirm', operationId: 'memory-confirm' }
    expect((await post(`${route}memory-transition`, { change })).status).toBe(400)
    expect((await post(`${route}memory-transition`, { change, confirmed: true })).status).toBe(200)
    expect((await post(`${route}memory-propose`, {}, { 'x-omicos-csrf': '' })).status).toBe(403)
    const read = async (path: string) => (await fetchHost(`${base}/omicos/oss/api/${route}${path}`)).json() as Promise<any>
    expect((await read('memory-context')).entries).toEqual([])
    expect((await read('memory-context?session=fixture-session')).entries[0].text).toBe('GRCh38-private')
    expect((await read('memory-tree')).entries[0].state).toBe('confirmed')
    expect((await read(`memory-history?id=${proposed.id}`)).revisions.map((node: any) => node.state)).toEqual(['confirmed', 'proposed'])
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${route}memory-tree`)).status).toBe(401)
  })

  it('protects figure revision, explicit review, historical downloads and vector attachment routes', async () => {
    const reference = (await runtime.list())[0]; const project = await runtime.byId(reference.id); const prefix = `project/${reference.id}/`
    const ledger = await ScienceLedger.open(project.workspace)
    const png = Buffer.from([137,80,78,71,13,10,26,10]); const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted()</script></svg>')
    const artifacts = [png, svg].map((bytes, index) => ({ id: `figure-${index}`, path: `.omicos-oss/figure-${index}`, mime: index ? 'image/svg+xml' : 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }))
    try { ledger.saveExecutions('python', [{ id: 'figure-receipt', operationId: 'figure-receipt', sessionId: 'fixture', language: 'python', state: 'succeeded', code: 'plot(values)', output: '', artifacts, createdAt: '2026-10-25' }]) } finally { ledger.close() }
    await Promise.all(artifacts.map((artifact, index) => writeFile(join(project.workspace, artifact.path), index ? svg : png)))
    const candidates = await (await fetchHost(`${base}/omicos/oss/api/${prefix}figure-candidates`)).json() as any
    expect(candidates.entries).toHaveLength(2)
    const figure = { title: 'Test figure', caption: 'Declared caption', methods: [], dataReferences: [], source: candidates.entries[0].source, operationId: 'figure-save' }
    const savedResponse = await post(`${prefix}figure-save`, { figure }); expect(savedResponse.status).toBe(200); const saved = await savedResponse.json() as any
    expect((await post(`${prefix}figure-save`, { figure: { ...figure, id: saved.id, revision: 0, operationId: 'stale-figure' } })).status).toBe(409)
    const review = { id: saved.id, revision: saved.revision, decision: 'approved', note: 'Checked locally', operationId: 'figure-review' }
    expect((await post(`${prefix}figure-review`, { review })).status).toBe(400)
    expect((await post(`${prefix}figure-review`, { review, confirmed: true })).status).toBe(200)
    const artifact = await fetchHost(`${base}/omicos/oss/api/${prefix}figure-artifact?id=${saved.id}&revision=1`)
    expect(artifact.status).toBe(200); expect(Buffer.from(await artifact.arrayBuffer())).toEqual(png)
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}figure-artifact?id=${saved.id}`)).status).toBe(401)
    const vector = await (await post(`${prefix}figure-save`, { figure: { ...figure, source: candidates.entries[1].source, operationId: 'svg-figure' } })).json() as any
    const download = await fetchHost(`${base}/omicos/oss/api/${prefix}figure-artifact?id=${vector.id}`)
    expect(download.headers.get('content-type')).toBe('application/octet-stream'); expect(download.headers.get('content-disposition')).toContain('attachment'); expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    const manifest = await (await fetchHost(`${base}/omicos/oss/api/${prefix}figure-manifest?id=${saved.id}`)).json() as any
    expect(manifest.figure.execution.code).toBe('plot(values)'); expect(manifest.figure.review.state).toBe('approved')
    await writeFile(join(project.workspace, artifacts[0].path), 'changed')
    expect((await fetchHost(`${base}/omicos/oss/api/${prefix}figure-artifact?id=${saved.id}`)).status).toBe(409)
  })

  it('discovers capabilities under owner auth and rejects unsupported protocols before mutation', async () => {
    expect((await globalThis.fetch(`${base}/omicos/oss/api/capabilities`)).status).toBe(401)
    const capabilityResponse = await fetchHost(`${base}/omicos/oss/api/capabilities`, { headers: { 'x-omicos-protocol': '999' } })
    expect(capabilityResponse.status).toBe(200); const capabilities = await capabilityResponse.json() as any
    expect(capabilities.protocol.current).toBe(1)
    expect(capabilities.features.find((item: any) => item.id === 'runtime.provisioning').state).toBe('unavailable')
    expect((await fetchHost(`${base}/omicos/oss/api/session`, { headers: { 'x-omicos-protocol': '999' } })).status).toBe(426)
    expect((await post('login', {}, { 'x-omicos-protocol': '2' })).status).toBe(426)
    expect(seen).toHaveLength(0)
    expect((await fetchHost(`${base}/omicos/oss/api/session`, { headers: { 'x-omicos-protocol': '1' } })).status).toBe(200)
  })

  it('requires AnnData plotting approval and fences a lost namespace before starting a new worker', async () => {
    const reference = (await runtime.list())[0]; const project = await runtime.byId(reference.id); const prefix = `project/${reference.id}/`
    const settings = { variable: 'adata', embedding: 'X_umap', color: 'none', maxPoints: 5 }
    expect((await post(`${prefix}anndata-plot`, { settings, operationId: 'not-approved' })).status).toBe(400)
    expect((await post(`${prefix}anndata-plot`, { settings: { ...settings, maxPoints: 10001 }, operationId: 'bad-plot', confirmed: true })).status).toBe(400)
    expect(project.snapshot().executions).toHaveLength(0)
    const request = { settings, operationId: 'lost-generation', expectedGeneration: '00000000-0000-4000-8000-000000000000', confirmed: true }
    const response = await post(`${prefix}anndata-plot`, request); expect(response.status).toBe(200); const submitted = await response.json() as any
    const duplicate = await (await post(`${prefix}anndata-plot`, request)).json() as any; expect(duplicate.id).toBe(submitted.id)
    const receipt = await (await fetchHost(`${base}/omicos/oss/api/${prefix}execution?id=${submitted.id}`)).json() as any
    expect(receipt.state).toBe('interrupted'); expect(project.snapshot().kernel.state).toBe('cold')
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}execution?id=${submitted.id}`)).status).toBe(401)
    expect((await fetchHost(`${base}/omicos/oss/api/${prefix}execution?id=${submitted.id}&language=r`)).status).toBe(404)
  })

  it('serves archived receipts/artifacts and streams the complete legacy Notebook independently of its recent snapshot', async () => {
    const reference = (await runtime.list())[0]; const project = await runtime.byId(reference.id); const prefix = `project/${reference.id}/`
    const bytes = Buffer.from('archived-figure'); const artifact = { id: 'archived-figure', path: '.omicos-oss/archived.png', mime: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    await writeFile(join(project.workspace, artifact.path), bytes)
    const ledger = await ScienceLedger.open(project.workspace)
    try { ledger.saveExecutions('python', Array.from({ length: 130 }, (_, index) => ({ id: `archived-${index}`, operationId: `archived-${index}`, sessionId: 'fixture', language: 'python' as const, state: 'succeeded' as const, code: `print(${index})`, output: String(index), artifacts: index === 0 ? [artifact] : [], createdAt: '2026-10-25' }))) } finally { ledger.close() }
    const read = async (path: string) => fetchHost(`${base}/omicos/oss/api/${prefix}${path}`)
    const first = await (await read('executions')).json() as any; expect(first.entries).toHaveLength(50); expect(first.total).toBe(130)
    expect((await (await read(`executions?before=${first.next}`)).json() as any).entries).toHaveLength(50)
    expect((await read('executions?before=invalid')).status).toBe(400)
    expect((await (await read('execution?id=archived-0')).json() as any).output).toBe('0')
    expect(Buffer.from(await (await read('artifact?id=archived-figure&execution=archived-0')).arrayBuffer())).toEqual(bytes)
    expect(Buffer.from(await (await read('artifact?id=archived-figure')).arrayBuffer())).toEqual(bytes)
    const exported = await read('notebook'); expect(exported.headers.get('content-disposition')).toContain('attachment')
    const book = await exported.json() as any; expect(book.cells).toHaveLength(130); expect(book.cells[0].outputs[0].text).toBe('0'); expect(book.cells.at(-1).source).toBe('print(129)')
    expect(project.snapshot().kernel.state).toBe('cold')
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}executions`)).status).toBe(401)
  })

  it('exposes paginated Pipeline summaries and exact old IDs without execution or cloud login', async () => {
    const reference = (await runtime.list())[0]; const project = await runtime.byId(reference.id); const pipelines = await runtime.pipelines(project.workspace)
    const pinned = pipelines.define({ title: 'Archived pipeline', language: 'python', steps: [{ id: 'only', code: 'print(42)' }] })
    const runs = Array.from({ length: 121 }, (_, index) => { const run = pipelines.store.create(pinned.id, `archived-run-${index}`).run; return pipelines.store.update(run.id, run.revision, 'fixture/completed', draft => { draft.state = 'succeeded' }) })
    const prefix = `${base}/omicos/oss/api/project/${reference.id}/`
    const first = await (await fetchHost(`${prefix}pipelines`)).json() as any
    expect(first.runs).toHaveLength(50); expect(first.runPage.total).toBe(121)
    const second = await (await fetchHost(`${prefix}pipelines?runsBefore=${first.runPage.next}`)).json() as any
    expect(second.runs).toHaveLength(50)
    const found = await (await fetchHost(`${prefix}pipelines?runQuery=${runs[0].id}`)).json() as any
    expect(found.runs.map((run: any) => run.id)).toEqual([runs[0].id])
    expect((await (await fetchHost(`${prefix}pipeline-run?run=${runs[0].id}`)).json() as any).definitionId).toBe(pinned.id)
    expect((await fetchHost(`${prefix}pipelines?state=unknown`)).status).toBe(400)
    expect((await fetchHost(`${prefix}pipelines?definitionsBefore=NaN`)).status).toBe(400)
    expect((await globalThis.fetch(`${prefix}pipelines`)).status).toBe(401)
    expect(project.kernelState().state).toBe('cold'); expect(seen).toHaveLength(0)
  })

  it('announces Core compatibility mode without advertising an unregistered Scientist preset', async () => {
    const core = createServer(createOssHandler(runtime, owner, { backend: 'core' })); const address = await listen(core)
    try {
      const session = await (await fetchHost(`${address}/omicos/oss/api/session`)).json() as any
      expect(session.backend).toBe('core')
      const chat = await (await fetchHost(`${address}/omicos/oss/api/project/${session.projects[0].id}/chat`)).json() as any
      expect(chat.available).toBe(false); expect(chat.reason).toContain('Core 兼容后端')
    } finally { await close(core) }
  })
  it('uses device pairing without Core, keeps tokens out of the browser and writes owner-only credentials', async () => {
    await login()
    const response = await (await fetchHost(`${base}/omicos/oss/api/session`)).text()
    expect(response).toContain('test@example.invalid')
    expect(response).not.toContain('private-user-token'); expect(response).not.toContain('private-device')
    const credentials = join(directory, 'state', 'cloud.json')
    expect((await stat(credentials)).mode & 0o777).toBe(0o600)
    expect(await readFile(credentials, 'utf8')).not.toContain('never-persist-this')
    await post('logout', {})
    expect(await readFile(credentials, 'utf8')).toBe('null')
  })
  it('never reuses official credentials against a different cloud origin', async () => {
    await login()
    const other = await CloudService.open('https://other.example.invalid', join(directory, 'state', 'cloud.json'), async () => { throw new Error('No request should carry old credentials') })
    expect(other.snapshot()).toMatchObject({ logged_in: false })
    await expect(other.subscription()).rejects.toMatchObject({ status: 401 })
  })
  it('keeps membership reads authenticated and binds cancel/restore to the requested query domain', async () => {
    expect((await fetchHost(`${base}/omicos/oss/api/subscriptions`)).status).toBe(401)
    expect((await fetchHost(`${base}/omicos/oss/api/reminders`)).status).toBe(401)
    await login()
    const subscriptions = await (await fetchHost(`${base}/omicos/oss/api/subscriptions`)).json() as any
    expect(subscriptions.subscriptions.map((item: any) => item.domain)).toEqual(['omics', 'humanities_social'])
    expect(subscriptions.subscriptions[0].auto_renew).toBe(false)
    const reminders = await (await fetchHost(`${base}/omicos/oss/api/reminders`)).json() as any
    expect(reminders.reminders[0].domain).toBe('humanities_social')
    expect((await post('subscription/manage', { action: 'cancel', domain: 'humanities_social' })).status).toBe(400)
    expect((await post('subscription/manage', { action: 'cancel', domain: 'humanities_social', confirmed: true })).status).toBe(200)
    expect((await post('subscription/manage', { action: 'uncancel', domain: 'humanities_social', confirmed: true })).status).toBe(200)
    const mutations = seen.filter(item => item.path.includes('/subscription/cancel') || item.path.includes('/subscription/uncancel'))
    expect(mutations.map(item => item.path)).toEqual(['/api/billing/subscription/cancel?domain=humanities_social', '/api/billing/subscription/uncancel?domain=humanities_social'])
    expect(mutations.every(item => JSON.stringify(item.body) === '{}')).toBe(true)
    expect((await post('subscription/manage', { action: 'cancel', domain: 'omics&domain=other', confirmed: true })).status).toBe(400)
    expect(orders).toBe(0)
  })

  it('requires login, a valid quote and one-use confirmation before creating orders', async () => {
    const choice = { plan_code: 'pro', period: 'monthly', provider: 'wechat' }
    expect((await post('quote', choice)).status).toBe(401)
    await login()
    expect((await post('quote', { ...choice, provider: 'mock' })).status).toBe(400)
    expect((await post('checkout', { confirmation: 'invented' })).status).toBe(409)
    const quote = await (await post('quote', choice)).json() as any
    expect(quote.catalog_amount_rmb).toBe(10)
    expect(orders).toBe(0)
    const checkout = await (await post('checkout', { confirmation: quote.confirmation })).json() as any
    expect(checkout.order_no).toBe('ord_1'); expect(orders).toBe(1)
    expect((await post('checkout', { confirmation: quote.confirmation })).status).toBe(409)
    const request = seen.find(item => item.path === '/api/billing/checkout')!
    expect(request.body).toEqual(choice); expect(request.authorization).toBe('Bearer private-user-token')
    expect((await post('webhook/mock', { order_no: 'ord_1' })).status).toBe(404)
  })
  it('restores a saved order through authenticated routes, and hides QR after paid or logout', async () => {
    expect((await fetchHost(`${base}/omicos/oss/api/orders`)).status).toBe(401)
    await login()
    const quote = await (await post('quote', { plan_code: 'pro', period: 'monthly', provider: 'wechat' })).json() as any
    await post('checkout', { confirmation: quote.confirmation })
    const get = async (path: string) => (await fetchHost(`${base}/omicos/oss/api/${path}`)).json() as Promise<any>
    const listing = await get('orders')
    expect(listing.orders[0].order_no).toBe('ord_1'); expect(JSON.stringify(listing)).not.toContain('weixin:')
    expect((await get('order/reopen?id=ord_1')).payment.pay_url).toContain('weixin:')
    paid = true
    expect((await get('order/reopen?id=ord_1')).payment.pay_url).toBe('')
    await post('logout', {})
    expect((await fetchHost(`${base}/omicos/oss/api/order/reopen?id=ord_1`)).status).toBe(401)
  })
  it('gets payment and entitlement state from the server; logout invalidates quotes', async () => {
    await login()
    const quote = await (await post('quote', { plan_code: 'pro', period: 'monthly', provider: 'alipay' })).json() as any
    await post('checkout', { confirmation: quote.confirmation })
    const get = async (path: string) => await (await fetchHost(`${base}/omicos/oss/api/${path}`)).json() as any
    expect((await get('order?id=ord_1')).status).toBe('pending')
    paid = true
    expect((await get('order?id=ord_1')).status).toBe('paid')
    expect((await get('subscription')).active).toBe(true)
    const next = await (await post('quote', { plan_code: 'pro', period: 'monthly', provider: 'alipay' })).json() as any
    await post('logout', {})
    expect((await post('checkout', { confirmation: next.confirmation })).status).toBe(409)
    expect((await fetchHost(`${base}/omicos/oss/api/order?id=ord_1`)).status).toBe(401)
  })
  it('rejects stale-window cloud mutations before dispatch, including relogin to the same account', async () => {
    await login()
    const observed = encodeURIComponent(runtime.cloud.identity())
    await post('logout', {})
    await login()
    const before = seen.length
    const stale = await post('subscription/manage', { action: 'cancel', confirmed: true }, { 'x-omicos-account': observed })
    expect(stale.status).toBe(409)
    expect((await stale.json() as any).error).toBe('Cloud account changed; refresh before submitting')
    expect(seen).toHaveLength(before)
    expect((await post('quote', { plan_code: 'pro', period: 'monthly', provider: 'wechat' }, { 'x-omicos-account': '' })).status).toBe(409)
    expect(seen).toHaveLength(before)
  })
  it('uses authoritative lab prices and validates seat and period constraints', async () => {
    await login()
    const choice = { plan_code: 'lab', period: 'monthly', provider: 'wechat', lab_name: 'Test lab', seats: 3 }
    const quote = await (await post('quote', choice)).json() as any
    expect(quote.catalog_amount_rmb).toBe(24)
    expect((await post('quote', { ...choice, seats: 2 })).status).toBe(400)
    expect((await post('quote', { ...choice, period: 'quarterly' })).status).toBe(400)
    expect((await post('lab/seats', { labId: 'lab_1', seats: 4, provider: 'wechat' })).status).toBe(400)
    const change = await post('lab/seats', { labId: 'lab_1', seats: 4, provider: 'wechat', confirmed: true })
    expect(change.status).toBe(200)
    expect(seen.find(request => request.path === '/api/billing/lab/lab_1/seats')?.body).toEqual({ seats: 4, provider: 'wechat' })
  })
  it('requires explicit invoice actions and forwards order IDs rather than caller-supplied amounts', async () => {
    await login()
    const invoice = { order_nos: ['ord_1'], buyer_type: 'personal', buyer_title: 'Researcher', invoice_kind: 'normal', buyer_email: 'research@example.invalid', amount_rmb_cents: 999999 }
    expect((await post('invoice', { invoice })).status).toBe(400)
    expect((await post('invoice', { invoice, confirmed: true })).status).toBe(200)
    const submitted = seen.find(request => request.path === '/api/billing/invoicing/invoices')!
    expect(submitted.body.order_nos).toEqual(['ord_1'])
    expect(submitted.body).not.toHaveProperty('amount_rmb_cents')
    expect((await post('invoice', { confirmed: true, invoice: { ...invoice, invoice_kind: 'special' } })).status).toBe(400)
    expect((await post('invoice/withdraw', { id: 'inv_1' })).status).toBe(400)
    expect((await post('invoice/withdraw', { id: 'inv_1', confirmed: true })).status).toBe(200)
    expect((await post('invoice/withdraw', { id: '../inv_1', confirmed: true })).status).toBe(400)
  })
  it('streams committed scientific receipts and resumes strictly after Last-Event-ID', async () => {
    const id = (await runtime.list())[0].id
    const service = await runtime.byId(id)
    const initial = service.eventCursor
    const abort = new AbortController()
    const response = await fetchHost(`${base}/omicos/oss/api/project/${id}/events?after=${initial}`, { signal: abort.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader(); let text = ''
    const readUntil = async (predicate: (text: string) => boolean) => {
      while (!predicate(text)) { const chunk = await reader.read(); if (chunk.done) throw new Error('Stream ended early'); text += new TextDecoder().decode(chunk.value) }
    }
    await readUntil(text => text.includes('event: hello'))
    await post(`project/${id}/execute`, { code: 'print(42)', operationId: 'streamed', confirmed: true })
    await readUntil(text => text.includes('execution/succeeded'))
    const receipts = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => typeof event.seq === 'number')
    expect(receipts.some(event => event.type === 'execution/queued')).toBe(true)
    expect(receipts.every(event => event.seq > initial)).toBe(true)
    const cursor = receipts[receipts.length - 1].seq
    abort.abort()
    const reconnectAbort = new AbortController()
    const resumed = await fetchHost(`${base}/omicos/oss/api/project/${id}/events?after=0`, { signal: reconnectAbort.signal, headers: { 'last-event-id': String(cursor) } })
    const resumedReader = resumed.body!.getReader(); let resumedText = ''
    await service.remember('stream-fact', 'GRCh38', 'user confirmed')
    while (!resumedText.includes('memory/saved')) { const chunk = await resumedReader.read(); if (chunk.done) throw new Error('Reconnect stream ended'); resumedText += new TextDecoder().decode(chunk.value) }
    expect(resumedText).not.toContain('execution/queued')
    expect(resumedText).toContain('stream-fact')
    reconnectAbort.abort()
  }, 15000)
  it('requires explicit approval for Notebook cells and returns conflicts instead of overwriting edits', async () => {
    const id = (await runtime.list())[0].id
    const created = await (await post(`project/${id}/notebook-create`, { title: 'HTTP analysis', language: 'python' })).json() as any
    const saved = await (await post(`project/${id}/notebook-save`, { id: created.id, revision: created.revision, title: 'Saved', cells: [{ ...created.cells[0], source: 'print(17)' }] })).json() as any
    expect((await post(`project/${id}/notebook-save`, { id: created.id, revision: 1, title: 'Stale', cells: created.cells })).status).toBe(409)
    const operation = { id: saved.id, revision: saved.revision, cellId: saved.cells[0].id, operationId: 'http-notebook' }
    expect((await post(`project/${id}/notebook-run`, operation)).status).toBe(400)
    const service = await runtime.byId(id)
    expect(service.snapshot().executions).toHaveLength(0)
    const result = await (await post(`project/${id}/notebook-run`, { ...operation, confirmed: true })).json() as any
    const retried = await (await post(`project/${id}/notebook-run`, { ...operation, confirmed: true })).json() as any
    expect(retried.execution.id).toBe(result.execution.id)
    for (let count = 0; count < 100 && service.get(result.execution.id)?.state !== 'succeeded'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    const download = await fetchHost(`${base}/omicos/oss/api/project/${id}/notebook-download?id=${saved.id}`)
    expect(download.headers.get('content-disposition')).toContain('.ipynb')
    const exported = await download.json() as any
    expect(exported.cells[0].outputs[0].text.trim()).toBe('17')
    expect((await (await fetchHost(`${base}/omicos/oss/api/project/${id}/notebooks`)).json() as any).notebooks[0].revision).toBe(3)
  })
  it('serves pinned Pipeline definitions, approved background execution and journal without cloud login', async () => {
    const project = (await runtime.list())[0].id; const prefix = `project/${project}/`
    const definition = await (await post(`${prefix}pipeline-define`, { definition: { title: 'HTTP Pipeline', language: 'python', steps: [{ id: 'one', code: 'value = 40' }, { id: 'two', gate: true, code: 'print(value + 2)' }] } })).json() as any
    expect(definition.id).toMatch(/^[a-f0-9]{64}$/)
    expect((await post(`${prefix}pipeline-start`, { definitionId: definition.id, operationId: 'http-pipeline' })).status).toBe(400)
    const run = await (await post(`${prefix}pipeline-start`, { definitionId: definition.id, operationId: 'http-pipeline', confirmed: true })).json() as any
    const service = await runtime.pipelines((await runtime.byId(project)).workspace)
    for (let count = 0; count < 150 && service.get(run.id).state !== 'waiting'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    const waiting = service.get(run.id)
    expect(waiting.state).toBe('waiting')
    expect((await post(`${prefix}pipeline-control`, { runId: run.id, revision: 1, action: 'continue', confirmed: true })).status).toBe(409)
    expect((await post(`${prefix}pipeline-control`, { runId: run.id, revision: waiting.revision, action: 'continue', confirmed: true })).status).toBe(200)
    for (let count = 0; count < 150 && service.get(run.id).state !== 'succeeded'; count++) await new Promise(resolve => setTimeout(resolve, 20))
    const executionId = service.get(run.id).attempts.at(-1)!.executionId
    const execution = await (await fetchHost(`${base}/omicos/oss/api/${prefix}pipeline-execution?run=${run.id}&execution=${executionId}`)).json() as any
    expect(execution.output.trim()).toBe('42')
    const journal = await (await fetchHost(`${base}/omicos/oss/api/${prefix}pipeline-events?run=${run.id}`)).json() as any
    expect(journal.events.some((event: any) => event.type === 'run/succeeded')).toBe(true)
    expect(seen).toHaveLength(0)
  })
  it('captures project dossier sources under owner/CSRF control and requires explicit human review',async()=>{
    const id=(await runtime.list())[0].id;const prefix=`project/${id}/`;const project=await runtime.byId(id);const notebook=await project.notebooks.create('Dossier source','python')
    const entry={operationId:'capture',title:'HTTP finding',finding:'Owner interpretation',limitations:'Not scientific validation',tags:['test'],sources:[{kind:'notebook',id:notebook.id}]}
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}dossier-list`)).status).toBe(401)
    expect((await post(`${prefix}dossier-save`,{entry})).status).toBe(400)
    const captured=await(await post(`${prefix}dossier-save`,{entry,confirmed:true})).json() as any;expect(captured.state).toBe('draft');expect(captured.sources[0].data.title).toBe('Dossier source')
    const review={id:captured.id,revision:1,operationId:'review',action:'review',note:'Checked source snapshot and limitations'};expect((await post(`${prefix}dossier-review`,{review})).status).toBe(400);expect((await post(`${prefix}dossier-review`,{review,confirmed:true})).status).toBe(200)
    await project.notebooks.save(notebook.id,1,'Changed source',notebook.cells)
    const integrity=await(await fetchHost(`${base}/omicos/oss/api/${prefix}dossier-integrity?id=${captured.id}`)).json() as any;expect(integrity.state).toBe('needs-review')
    const exported=await(await fetchHost(`${base}/omicos/oss/api/${prefix}dossier-export?id=${captured.id}`)).json() as any;expect(exported.entry.sources[0].data.title).toBe('Dossier source');expect(project.snapshot().executions).toEqual([]);expect(seen).toHaveLength(0)
  })
  it('keeps method publication human-only, preserves immutable versions and rejects withdrawn Pipeline pins before execution', async () => {
    const id=(await runtime.list())[0].id;const prefix=`project/${id}/`;const document={key:'lab.http',version:'1.0.0',title:'HTTP method',description:'Fixture',body:'Inspect source before analysis; no automatic execution.',authors:['Fixture author'],sources:['https://example.org/source'],license:{id:'MIT',text:'Declared fixture license'}};const pack={schema:'omicos.methods/1',methods:[{...document,review:{state:'published'}}]}
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}method-list`)).status).toBe(401)
    expect((await post(`${prefix}method-import`,{pack,operationId:'unapproved'})).status).toBe(400)
    const imported=await(await post(`${prefix}method-import`,{confirmed:true,pack,operationId:'import'})).json() as any;const draft=imported[0];expect(draft.review.state).toBe('draft')
    const review={id:draft.id,revision:1,action:'publish',operationId:'publish',note:'Reviewed fixture scope and source/license declarations'};expect((await post(`${prefix}method-review`,{review})).status).toBe(400)
    expect((await post(`${prefix}method-review`,{confirmed:true,review})).status).toBe(200)
    const reference=await(await fetchHost(`${base}/omicos/oss/api/${prefix}method-reference?id=${draft.id}`)).json() as any;expect(reference.id).toBe(`omicos-method:${draft.id}`)
    const defined=await(await post(`${prefix}pipeline-define`,{definition:{title:'Pinned method fixture',language:'python',references:[reference],steps:[{id:'s',code:'print(42)'}]}})).json() as any;expect(defined.id).toMatch(/^[a-f0-9]{64}$/)
    expect((await post(`${prefix}method-review`,{confirmed:true,review:{...review,revision:2,operationId:'withdraw',action:'withdraw',note:'Do not run this version'}})).status).toBe(200)
    expect((await post(`${prefix}pipeline-start`,{confirmed:true,definitionId:defined.id,operationId:'must-not-start'})).status).toBe(409)
    const history=await(await fetchHost(`${base}/omicos/oss/api/${prefix}method-history?id=${draft.id}`)).json() as any;expect(history.reviews.map((review:any)=>review.state)).toEqual(['withdrawn','published','draft'])
    expect((await runtime.byId(id)).kernelState().state).toBe('cold');expect(seen).toHaveLength(0)
  })
  it('imports verified raw binary chunks only after owner/CSRF approval and never overwrites or executes uploaded data', async () => {
    const id=(await runtime.list())[0].id;const prefix=`project/${id}/upload-`;const bytes=Buffer.from('sample,value\na,42\nb,43\n');const digest=createHash('sha256').update(bytes).digest('hex');const upload={operationId:'http-import',directory:'',name:'uploaded.csv',bytes:bytes.length,chunkHashes:[digest],expectedSha256:digest}
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}list`)).status).toBe(401)
    expect((await post(`${prefix}start`,{upload})).status).toBe(400)
    const started=await(await post(`${prefix}start`,{confirmed:true,upload})).json() as any;expect(started.state).toBe('uploading')
    const chunkPath=`${base}/omicos/oss/api/${prefix}chunk?id=${started.id}&offset=0`
    expect((await globalThis.fetch(chunkPath,{method:'PUT',headers:{'content-type':'application/octet-stream','x-omicos-csrf':csrf},body:bytes})).status).toBe(401)
    expect((await fetchHost(chunkPath,{method:'PUT',headers:{'content-type':'application/octet-stream','x-omicos-csrf':'wrong'},body:bytes})).status).toBe(403)
    expect((await fetchHost(chunkPath,{method:'PUT',headers:{'content-type':'application/json','x-omicos-csrf':csrf},body:bytes})).status).toBe(415)
    expect((await fetchHost(chunkPath,{method:'PUT',headers:{'content-type':'application/octet-stream','x-omicos-csrf':csrf},body:Buffer.from('bad')})).status).toBe(422)
    const result=await fetchHost(chunkPath,{method:'PUT',headers:{'content-type':'application/octet-stream','x-omicos-csrf':csrf,'x-omicos-protocol':'1'},body:bytes});expect(result.status).toBe(200);const ack=await result.json() as any;expect(ack.received).toBe(bytes.length);expect(ack).not.toHaveProperty('chunkHashes')
    expect((await post(`${prefix}finalize`,{id:started.id})).status).toBe(400)
    const completed=await(await post(`${prefix}finalize`,{id:started.id,confirmed:true})).json() as any;expect(completed.state).toBe('completed');expect(completed.sha256).toBe(digest);const project=await runtime.byId(id);expect(await readFile(join(project.workspace,'uploaded.csv'))).toEqual(bytes)
    expect((await post(`${prefix}start`,{confirmed:true,upload:{...upload,operationId:'overwrite'}})).status).toBe(409)
    expect((await post(`${prefix}cancel`,{id:started.id,confirmed:true})).status).toBe(409)
    expect(project.snapshot().executions).toEqual([]);expect(project.kernelState().state).toBe('cold');expect(seen).toHaveLength(0)
  })
  it('keeps managed environment installation and next-Host selection behind owner/CSRF and explicit human confirmation', async () => {
    const id=(await runtime.list())[0].id;const prefix=`project/${id}/managed-environment-`
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}list`)).status).toBe(401)
    expect((await post(`${prefix}install`,{install:{title:'Unapproved',operationId:'unapproved',packages:[]}})).status).toBe(400)
    expect((await post(`${prefix}install`,{confirmed:true,install:{title:'No CSRF',operationId:'wrong-csrf',packages:[]}},{'x-omicos-csrf':'wrong'})).status).toBe(403)
    expect((await post(`${prefix}install`,{confirmed:true,install:{title:'Invalid',operationId:'invalid',packages:[{name:'numpy',version:'latest',sha256:[]}]}})).status).toBe(400)
    const listing=await(await fetchHost(`${base}/omicos/oss/api/${prefix}list`)).json() as any;expect(listing.entries).toEqual([]);expect(listing.selection.environmentId).toBeNull()
    expect((await post(`${prefix}select`,{selection:{operationId:'rollback',revision:1,environmentId:null}})).status).toBe(400)
    expect((await post(`${prefix}select`,{confirmed:true})).status).toBe(400)
    expect((await post(`${prefix}select`,{confirmed:true,selection:{operationId:'empty-choice',revision:1,environmentId:''}})).status).toBe(400)
    const selected=await(await post(`${prefix}select`,{confirmed:true,selection:{operationId:'rollback',revision:1,environmentId:null}})).json() as any;expect(selected.revision).toBe(2)
    expect((await post(`${prefix}select`,{confirmed:true,selection:{operationId:'stale',revision:1,environmentId:null}})).status).toBe(409)
    expect((await runtime.byId(id)).kernelState().state).toBe('cold');expect(seen).toHaveLength(0)
  })
  it('requires owner/CSRF and explicit confirmation for versioned human plan decisions without implicit execution', async () => {
    const id = (await runtime.list())[0].id; const prefix = `project/${id}/research-plan-`
    const definition = { title: 'HTTP research plan', objective: 'Inspect sources before analysis', steps: [{ id: 'inspect', title: 'Inspect', inputs: ['declared input'], outputs: ['report'], methods: ['method v1'], risk: 'Do not transform data', acceptance: 'Actual receipt and human assessment' }] }
    expect((await globalThis.fetch(`${base}/omicos/oss/api/${prefix}list`)).status).toBe(401)
    expect((await post(`${prefix}propose`,{plan:{definition,operationId:'create'}},{'x-omicos-csrf':'wrong'})).status).toBe(403)
    const draft = await (await post(`${prefix}propose`,{plan:{definition,operationId:'create'}})).json() as any
    expect(draft.status).toBe('draft')
    const decision = {id:draft.id,revision:draft.revision,action:'approve',note:'Reviewed exact definition',operationId:'approve'}
    expect((await post(`${prefix}decide`,{decision})).status).toBe(400)
    const approved = await (await post(`${prefix}decide`,{confirmed:true,decision})).json() as any
    expect(approved.status).toBe('approved')
    expect((await post(`${prefix}decide`,{confirmed:true,decision:{...decision,action:'reject',operationId:'stale'}})).status).toBe(409)
    expect((await post(`${prefix}decide`,{confirmed:true,decision:{...decision,revision:approved.revision,action:'complete',stepId:'inspect',operationId:'no-receipt'}})).status).toBe(400)
    const service = await runtime.byId(id); expect(service.kernelState().state).toBe('cold'); expect(service.snapshot().executions).toEqual([])
    const receipt = await service.submit('print(42)','http-plan-execution','plan')
    for (let i=0; i<150 && ['queued','running'].includes(service.get(receipt.id)!.state); i++) await new Promise(resolve=>setTimeout(resolve,20))
    expect(service.get(receipt.id)?.state).toBe('succeeded')
    const completed = await (await post(`${prefix}decide`,{confirmed:true,decision:{...decision,revision:approved.revision,action:'complete',stepId:'inspect',evidence:[{kind:'project',executionId:receipt.id}],operationId:'complete'}})).json() as any
    expect(completed.assessments[0].evidence[0].executionId).toBe(receipt.id)
    const history = await (await fetchHost(`${base}/omicos/oss/api/${prefix}history?id=${draft.id}`)).json() as any
    expect(history.revisions.map((revision:any)=>revision.action)).toEqual(['complete','approve','propose'])
    const revised = await (await post(`${prefix}propose`,{plan:{id:draft.id,revision:completed.revision,definition:{...definition,title:'Changed analysis'},operationId:'edit'}})).json() as any
    expect(revised.status).toBe('draft'); expect(revised.assessments).toEqual([]); expect(service.snapshot().executions).toHaveLength(1); expect(seen).toHaveLength(0)
  })
  it('executes only registered workspaces and exports a real notebook', async () => {
    const id = (await runtime.list())[0].id
    expect((await post('project/not-registered/execute', { code: '1', confirmed: true })).status).not.toBe(200)
    const job = await (await post(`project/${id}/execute`, { code: 'amount=42\nprint(amount)', operationId: 'one', confirmed: true })).json() as any
    const service = await runtime.byId(id)
    for (let i = 0; i < 100 && ['running', 'queued'].includes(service.get(job.id)!.state); i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(job.id)?.state).toBe('succeeded')
    const notebook = await (await fetchHost(`${base}/omicos/oss/api/project/${id}/notebook`)).json() as any
    expect(notebook.cells[0].outputs[0].text).toContain('42')
  })
})
