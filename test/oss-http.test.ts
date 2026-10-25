import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest, createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
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
      else if (path.startsWith('/api/billing/orders/')) response.end(JSON.stringify({ order_no: 'ord_1', status: paid ? 'paid' : 'pending' }))
      else if (path.startsWith('/api/billing/subscription')) response.end(JSON.stringify({ active: paid, subscription: paid ? { plan_code: 'pro' } : undefined }))
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
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => fetchHost(`${base}/omicos/oss/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': csrf, ...headers }, body: JSON.stringify(data) })
  const login = async () => { approvals = true; expect((await post('login', {})).status).toBe(200); expect((await post('login/poll', {})).status).toBe(200) }
  it('blocks cross-origin, DNS rebinding and unauthenticated mutations', async () => {
    expect((await post('logout', {}, { origin: 'https://attacker.invalid' })).status).toBe(403)
    expect((await post('logout', {}, { 'x-omicos-csrf': '' })).status).toBe(403)
    const rebinding = await new Promise<number | undefined>(resolve => { const request = httpRequest(`${base}/omicos/oss/api/session`, { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode) }); request.end() })
    expect(rebinding).toBe(403)
    const projects = await runtime.list()
    expect((await post(`project/${projects[0].id}/execute`, { code: 'print(1)', operationId: 'x' })).status).toBe(400)
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
