import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest, createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OssRuntime } from '../src/oss/runtime.js'
import { createOssHandler } from '../src/oss/http.js'
import { CloudService } from '../src/oss/cloud.js'

const listen = (server: Server): Promise<string> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)))
const close = (server: Server): Promise<void> => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() })
describe('scientific workbench and commerce boundary', () => {
  let directory: string; let runtime: OssRuntime; let cloud: Server; let server: Server; let base: string
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
      else if (path.startsWith('/api/plans')) response.end(JSON.stringify({ plans: [{ code: 'pro', name: 'Pro', monthly_price_rmb: 10, yearly_price_rmb: 100 }] }))
      else if (!request.headers.authorization) { response.statusCode = 401; response.end('{}') }
      else if (path === '/api/billing/checkout') { orders++; response.end(JSON.stringify({ order_no: `ord_${orders}`, amount_rmb: 10, currency: 'CNY', pay_url: 'weixin://wxpay/bizpayurl?pr=example', provider: body.provider, expires_at: '2099-01-01' })) }
      else if (path.startsWith('/api/billing/orders/')) response.end(JSON.stringify({ order_no: 'ord_1', status: paid ? 'paid' : 'pending' }))
      else if (path.startsWith('/api/billing/subscription')) response.end(JSON.stringify({ active: paid, subscription: paid ? { plan_code: 'pro' } : undefined }))
      else { response.statusCode = 404; response.end('{}') }
    })
    const cloudBase = await listen(cloud)
    runtime = await OssRuntime.open({ cloudBase, stateDir: join(directory, 'state') })
    await runtime.project(join(directory, 'project'))
    server = createServer(createOssHandler(runtime)); base = await listen(server)
    csrf = (await (await fetch(`${base}/omicos/oss/api/session`)).json() as any).csrf
  })
  afterEach(async () => { await close(server); await runtime.dispose(); await close(cloud); await rm(directory, { recursive: true, force: true }) })
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => fetch(`${base}/omicos/oss/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': csrf, ...headers }, body: JSON.stringify(data) })
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
    const response = await (await fetch(`${base}/omicos/oss/api/session`)).text()
    expect(response).toContain('test@example.invalid')
    expect(response).not.toContain('private-user-token'); expect(response).not.toContain('private-device')
    const credentials = join(directory, 'state', 'cloud.json')
    expect((await stat(credentials)).mode & 0o777).toBe(0o600)
    expect(await readFile(credentials, 'utf8')).not.toContain('never-persist-this')
    await post('logout', {})
    expect(await readFile(credentials, 'utf8')).toBe('null')
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
    const get = async (path: string) => await (await fetch(`${base}/omicos/oss/api/${path}`)).json() as any
    expect((await get('order?id=ord_1')).status).toBe('pending')
    paid = true
    expect((await get('order?id=ord_1')).status).toBe('paid')
    expect((await get('subscription')).active).toBe(true)
    const next = await (await post('quote', { plan_code: 'pro', period: 'monthly', provider: 'alipay' })).json() as any
    await post('logout', {})
    expect((await post('checkout', { confirmation: next.confirmation })).status).toBe(409)
    expect((await fetch(`${base}/omicos/oss/api/order?id=ord_1`)).status).toBe(401)
  })
  it('executes only registered workspaces and exports a real notebook', async () => {
    const id = (await runtime.list())[0].id
    expect((await post('project/not-registered/execute', { code: '1', confirmed: true })).status).not.toBe(200)
    const job = await (await post(`project/${id}/execute`, { code: 'amount=42\nprint(amount)', operationId: 'one', confirmed: true })).json() as any
    const service = await runtime.byId(id)
    for (let i = 0; i < 100 && ['running', 'queued'].includes(service.get(job.id)!.state); i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.get(job.id)?.state).toBe('succeeded')
    const notebook = await (await fetch(`${base}/omicos/oss/api/project/${id}/notebook`)).json() as any
    expect(notebook.cells[0].outputs[0].text).toContain('42')
  })
})
