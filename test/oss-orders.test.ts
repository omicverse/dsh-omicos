import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CloudService } from '../src/oss/cloud.js'
import { OrderLedger } from '../src/oss/orders.js'
import { writeJson } from '../src/oss/storage.js'

let directory: string
const server = 'https://cloud.example.invalid'
const payment = { order_no: 'ord_receipt', amount_rmb: 10, currency: 'CNY', provider: 'wechat', pay_url: 'weixin://wxpay/bizpayurl?pr=LOCAL-TEST-ONLY', expires_at: '2099-01-01' }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-orders-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
async function service(fetcher: typeof fetch, userId = 'owner', base = server) {
  const file = join(directory, 'cloud.json')
  await writeJson(file, { server: base, token: 'private-user-token-never-in-ledger', user: { id: userId } })
  return CloudService.open(base, file, fetcher)
}
const quote = (cloud: CloudService) => cloud.quote({ plan_code: 'pro', period: 'monthly', provider: 'wechat' }) as Promise<{ confirmation: string }>
const plans = { plans: [{ code: 'pro', name: 'Pro', monthly_price_rmb: 10, yearly_price_rmb: 100 }] }
describe('durable scoped payment recovery', () => {
  it('persists receipts across restart, redacts list links and rechecks remote status before reopening', async () => {
    let status = 'pending'; let amount: number | undefined = 1000; let expires = payment.expires_at; let calls = 0
    const fetcher = (async (url: any) => {
      calls++
      if (String(url).endsWith('/api/plans')) return json(plans)
      if (String(url).endsWith('/checkout')) return json({ ...payment, unexpected_token: 'never-store-this-either' })
      return json({ order_no: payment.order_no, status, amount_rmb_cents: amount, provider: 'wechat', expires_at: expires })
    }) as typeof fetch
    const cloud = await service(fetcher)
    const created = await cloud.checkout((await quote(cloud)).confirmation) as any
    expect(created.unexpected_token).toBeUndefined()
    const restored = await CloudService.open(server, join(directory, 'cloud.json'), fetcher)
    const listing = await restored.localOrders() as any
    expect(listing.orders).toHaveLength(1); expect(listing.orders[0].status).toBe('unverified')
    expect(JSON.stringify(listing)).not.toContain(payment.pay_url)
    const before = calls
    const opened = await restored.reopenOrder(payment.order_no) as any
    expect(calls).toBe(before + 1); expect(opened.payment.pay_url).toBe(payment.pay_url)
    amount = 2000
    expect((await restored.reopenOrder(payment.order_no) as any).payment.pay_url).toBe('')
    amount = undefined
    expect((await restored.reopenOrder(payment.order_no) as any).payment.pay_url).toBe('')
    amount = 1000; expires = '2020-01-01'
    expect((await restored.reopenOrder(payment.order_no) as any).payment.pay_url).toBe('')
    expires = payment.expires_at; status = 'paid'
    expect(await restored.reopenOrder(payment.order_no)).toMatchObject({ status: 'paid', payment: { pay_url: '' } })
    const db = join(directory, 'cloud.json.orders.sqlite')
    const bytes = (await readFile(db)).toString('utf8')
    expect(bytes).not.toContain('private-user-token-never-in-ledger'); expect(bytes).not.toContain('never-store-this-either')
    expect((await stat(db)).mode & 0o777).toBe(0o600)
  })
  it('keeps receipts when logout races with a completed checkout, without exposing them to another account or origin', async () => {
    let release!: (value: Response) => void; let started!: () => void
    const received = new Promise<void>(resolve => { started = resolve })
    const fetcher = (async (url: any) => { if (String(url).endsWith('/api/plans')) return json(plans); started(); return new Promise<Response>(resolve => { release = resolve }) }) as typeof fetch
    const cloud = await service(fetcher)
    const checkout = cloud.checkout((await quote(cloud)).confirmation)
    const rejected = expect(checkout).rejects.toMatchObject({ status: 409 })
    await received; await cloud.logout(); release(json(payment)); await rejected
    const other = await service((async () => json({}, 403)) as typeof fetch, 'different-user')
    expect(await other.localOrders()).toMatchObject({ orders: [] })
    await expect(other.reopenOrder(payment.order_no)).rejects.toMatchObject({ status: 403 })
    const ledger = new OrderLedger(join(directory, 'cloud.json.orders.sqlite'))
    expect(await ledger.get({ server, userId: 'owner' }, payment.order_no)).toMatchObject({ pay_url: payment.pay_url })
    expect(await ledger.get({ server: 'https://another.example.invalid', userId: 'owner' }, payment.order_no)).toBeUndefined()
  })
  it('returns the already-created order with a recovery warning if local persistence fails, and never retries checkout', async () => {
    let checkouts = 0
    const cloud = await service((async (url: any) => String(url).endsWith('/api/plans') ? json(plans) : (checkouts++, json(payment))) as typeof fetch)
    await mkdir(join(directory, 'cloud.json.orders.sqlite'))
    const confirmation = (await quote(cloud)).confirmation
    const result = await cloud.checkout(confirmation) as any
    expect(result.order_no).toBe(payment.order_no); expect(result.recovery_warning).toMatch(/订单已创建/)
    expect(checkouts).toBe(1)
    await expect(cloud.checkout(confirmation)).rejects.toMatchObject({ status: 409 })
    expect(checkouts).toBe(1)
  })
  it('treats lost or incomplete checkout responses as unknown and never replays their confirmation', async () => {
    let checkouts = 0
    const cloud = await service((async (url: any) => {
      if (String(url).endsWith('/api/plans')) return json(plans)
      checkouts++
      if (checkouts === 1) throw new Error('Connection closed after remote creation')
      return json({ order_no: 'ord_incomplete' })
    }) as typeof fetch)
    const confirmation = (await quote(cloud)).confirmation
    await expect(cloud.checkout(confirmation)).rejects.toThrow(/结果尚未确认/)
    await expect(cloud.checkout(confirmation)).rejects.toMatchObject({ status: 409 })
    expect(checkouts).toBe(1)
    await expect(cloud.checkout((await quote(cloud)).confirmation)).rejects.toThrow(/ord_incomplete/)
    expect(checkouts).toBe(2)
  })
  it('paginates account-local receipts without leaking other accounts or payment URLs', async () => {
    const ledger = new OrderLedger(join(directory, 'orders.sqlite'))
    const scope = { server, userId: 'owner' }
    for (let index = 0; index < 53; index++) await ledger.record(scope, { ...payment, order_no: `ord_${index}` }, 'subscription')
    await ledger.record({ server, userId: 'other' }, { ...payment, order_no: 'hidden' }, 'lab-seats')
    const first = await ledger.list(scope); const second = await ledger.list(scope, first.next)
    expect(first.orders).toHaveLength(50); expect(second.orders).toHaveLength(3)
    expect(new Set([...first.orders, ...second.orders].map(order => order.order_no)).size).toBe(53)
    expect(JSON.stringify(first)).not.toContain('pay_url'); expect(second.next).toBeUndefined()
    await expect(ledger.list(scope, 'invalid')).rejects.toThrow(/cursor/)
  })
})
