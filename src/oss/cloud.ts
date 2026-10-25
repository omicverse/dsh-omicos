import type { InvoiceRequest, InvoicingSummary, LabPricing, SeatChange, LabSummary } from './commerce-types.js'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './storage.js'

interface Identity { id: string; email?: string; phone?: string; display_name?: string }
interface Credentials { server: string; token: string; user: Identity }
export interface Checkout { plan_code: string; period: 'monthly' | 'quarterly' | 'yearly'; provider: 'wechat' | 'alipay'; domain?: string; seats?: number; lab_id?: string; lab_name?: string }
interface CatalogPlan { code: string; name: string; display_name?: string; tagline?: string; monthly_price_rmb: number | null; quarterly_price_rmb?: number | null; yearly_price_rmb: number | null }
export class CloudError extends Error { constructor(readonly status: number, message: string) { super(message) } }
/** Host-only official cloud adapter. Never send credentials in public snapshots. */
export class CloudService {
  private credentials?: Credentials
  private generation = 0
  private login?: { device: string; code: string; uri: string; expires: number; interval: number; nextPoll: number }
  private quotes = new Map<string, { checkout: Checkout; generation: number; expires: number }>()
  private pendingCheckout = false
  private constructor(readonly base: string, private credentialFile: string, private fetcher: typeof fetch) {}
  static async open(base: string, credentialFile: string, fetcher: typeof fetch = fetch): Promise<CloudService> {
    const url = new URL(base)
    if (url.protocol !== 'https:' && !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) throw new Error('Cloud requires HTTPS (HTTP allowed only for local test servers)')
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Cloud base must be an origin without credentials')
    const cloud = new CloudService(url.origin, credentialFile, fetcher)
    const saved = await readJson<Credentials | undefined>(credentialFile, undefined)
    // Credentials are audience-bound; changing cloud origins must never forward an old token.
    if (saved?.server === cloud.base && typeof saved.token === 'string' && saved.user?.id) cloud.credentials = saved
    return cloud
  }
  private async request(path: string, method = 'GET', body?: unknown, authenticated = true): Promise<any> {
    const generation = this.generation
    if (authenticated && !this.credentials) throw new CloudError(401, '请先登录 OmicOS 云账号；本地分析无需登录')
    const response = await this.fetcher(`${this.base}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${this.credentials!.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data: any = await response.json().catch(() => ({}))
    if (generation !== this.generation) throw new CloudError(409, '账号已切换，请刷新')
    if (!response.ok) throw new CloudError(response.status, String(data.detail?.message ?? data.detail ?? data.message ?? `云服务 HTTP ${response.status}`))
    return data
  }
  get sensitiveFiles(): readonly string[] { return [this.credentialFile] }
  snapshot(): unknown {
    return { server: this.base, logged_in: Boolean(this.credentials), user: this.credentials?.user, generation: this.generation,
      login: this.login ? { user_code: this.login.code, verification_uri: this.login.uri, expires_at: this.login.expires } : undefined }
  }
  async beginLogin(): Promise<unknown> {
    if (this.login && this.login.expires > Date.now()) return this.snapshot()
    const generation = this.generation
    const data = await this.request('/api/auth/cli-device-code', 'POST', {}, false)
    if (generation !== this.generation) throw new CloudError(409, '账号已切换')
    const uri = new URL(data.verification_uri)
    if (uri.protocol !== 'https:' && uri.origin !== this.base) throw new Error('Unsafe verification URI')
    this.login = { device: data.device_code, code: data.user_code, uri: uri.href, interval: Math.max(2000, (data.interval || 2) * 1000), nextPoll: 0, expires: Date.now() + Math.min(data.expires_in || 300, 3600) * 1000 }
    return this.snapshot()
  }
  async pollLogin(): Promise<unknown> {
    const login = this.login
    if (!login || login.nextPoll > Date.now()) return this.snapshot()
    if (login.expires <= Date.now()) { this.login = undefined; throw new CloudError(410, '配对码已过期，请重新登录') }
    login.nextPoll = Date.now() + login.interval
    const generation = this.generation
    const data = await this.request('/api/auth/cli-poll', 'POST', { device_code: login.device }, false)
    if (generation !== this.generation || this.login !== login) throw new CloudError(409, '登录流程已取消')
    if (data.status === 'approved') {
      if (!data.user_token || !data.user?.id) throw new Error('Invalid cloud identity response')
      const user: Identity = { id: String(data.user.id), ...(typeof data.user.email === 'string' ? { email: data.user.email } : {}), ...(typeof data.user.phone === 'string' ? { phone: data.user.phone } : {}), ...(typeof data.user.display_name === 'string' ? { display_name: data.user.display_name } : {}) }
      const credentials = { server: this.base, token: data.user_token, user }
      // Persist only explicit-login credentials, never process/admin keys.
      await writeJson(this.credentialFile, credentials)
      if (generation !== this.generation || this.login !== login) { await writeJson(this.credentialFile, this.credentials ?? null); throw new CloudError(409, '登录已取消') }
      this.credentials = credentials; this.generation++; this.login = undefined; this.quotes.clear()
    } else if (data.status === 'expired') { this.login = undefined; throw new CloudError(410, '配对码已过期，请重新登录') }
    return this.snapshot()
  }
  async logout(): Promise<void> {
    this.generation++; this.login = undefined; this.credentials = undefined; this.quotes.clear()
    await writeJson(this.credentialFile, null)
  }
  plans(domain = ''): Promise<{ plans: CatalogPlan[] }> { return this.request(`/api/plans${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`, 'GET', undefined, false) }
  subscription(domain = ''): Promise<unknown> { return this.request(`/api/billing/subscription${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`) }
  subscriptions(): Promise<unknown> { return this.request('/api/billing/subscriptions') }
  async order(id: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new CloudError(400, '无效订单编号')
    const order = await this.request(`/api/billing/orders/${encodeURIComponent(id)}`)
    if (order.order_no !== id) throw new CloudError(502, '云端返回的订单编号不匹配，请保留订单信息联系官方')
    return order
  }
  async quote(input: Checkout): Promise<unknown> {
    if (!this.credentials) throw new CloudError(401, '购买前请登录')
    if (typeof input.plan_code !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.plan_code) || !['monthly', 'quarterly', 'yearly'].includes(input.period) || !['wechat', 'alipay'].includes(input.provider)) throw new CloudError(400, '无效套餐、周期或支付方式')
    const checkout: Checkout = { plan_code: input.plan_code, period: input.period, provider: input.provider }
    if (input.domain) { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.domain)) throw new CloudError(400, '无效服务域'); checkout.domain = input.domain }
    if (input.plan_code === 'lab') {
      if (!Number.isSafeInteger(input.seats) || input.seats! < 1 || input.seats! > 100000) throw new CloudError(400, '请输入有效席位数')
      checkout.seats = input.seats
      if (input.lab_id) checkout.lab_id = String(input.lab_id).slice(0, 200)
      else if (input.lab_name?.trim()) checkout.lab_name = input.lab_name.trim().slice(0, 200)
      else throw new CloudError(400, '请输入实验室名称或编号')
    }
    const generation = this.generation
    const catalog = await this.plans(checkout.domain)
    const plan = catalog.plans.find(plan => plan.code === checkout.plan_code)
    if (!plan) throw new CloudError(400, '套餐不在当前目录中')
    const field = `${checkout.period === 'monthly' ? 'monthly' : checkout.period === 'quarterly' ? 'quarterly' : 'yearly'}_price_rmb` as const
    let price = plan[field]
    if (checkout.plan_code === 'lab') {
      if (checkout.period === 'quarterly') throw new CloudError(400, '实验室套餐仅支持月付或年付')
      const pricing = await this.labPricing()
      if (!pricing.can_purchase || checkout.seats! < pricing.min_seats) throw new CloudError(400, `此账号暂不可购买或席位数少于 ${pricing.min_seats}`)
      price = (checkout.period === 'yearly' ? pricing.seat_price_yearly_rmb : pricing.seat_price_monthly_rmb) * checkout.seats!
      if (!Number.isFinite(price) || price <= 0) throw new CloudError(400, '席位价格不可用，请联系官方')
    }
    if (checkout.plan_code !== 'lab' && (typeof price !== 'number' || price <= 0)) throw new CloudError(400, '该套餐暂不支持此周期自助购买')
    if (generation !== this.generation) throw new CloudError(409, '账号已切换')
    this.quotes.clear()
    const confirmation = randomUUID()
    this.quotes.set(confirmation, { checkout, generation, expires: Date.now() + 300_000 })
    return { confirmation, checkout, plan: plan.display_name || plan.name, catalog_amount_rmb: price, notice: '目录价格仅供核对，最终金额以服务端订单为准；确认后生成付款订单。' }
  }
  async checkout(confirmation: string): Promise<unknown> {
    const quote = this.quotes.get(confirmation)
    if (!quote || quote.generation !== this.generation || quote.expires < Date.now()) throw new CloudError(409, '确认已过期，请重新选择套餐')
    if (this.pendingCheckout) throw new CloudError(409, '正在创建订单，请等待结果')
    this.pendingCheckout = true; this.quotes.delete(confirmation)
    try { return await this.request('/api/billing/checkout', 'POST', quote.checkout) }
    finally { this.pendingCheckout = false }
  }
  labPricing(): Promise<LabPricing> { return this.request('/api/billing/lab/pricing') }
  invoicing(): Promise<InvoicingSummary> { return this.request('/api/billing/invoicing') }
  labs(): Promise<{ labs: LabSummary[] }> { return this.request('/api/labs') }
  async requestInvoice(input: InvoiceRequest): Promise<unknown> {
    if (!input || typeof input !== 'object') throw new CloudError(400, '缺少开票申请')
    if (!Array.isArray(input.order_nos) || input.order_nos.length < 1 || input.order_nos.length > 100 || input.order_nos.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new CloudError(400, '请选择有效付款订单')
    if (!['personal', 'company'].includes(input.buyer_type) || !['normal', 'special'].includes(input.invoice_kind) || typeof input.buyer_title !== 'string' || !input.buyer_title.trim() || input.buyer_title.length > 200) throw new CloudError(400, '请填写有效抬头和发票类型')
    if (input.invoice_kind === 'special' && input.buyer_type !== 'company') throw new CloudError(400, '专票需要企业抬头')
    const request: InvoiceRequest = { order_nos: [...new Set(input.order_nos)], buyer_type: input.buyer_type, buyer_title: input.buyer_title.trim(), invoice_kind: input.invoice_kind }
    for (const field of ['buyer_tax_id', 'buyer_email', 'buyer_address', 'buyer_phone', 'buyer_bank', 'buyer_bank_account', 'remark'] as const) {
      const value = input[field]
      if (value !== undefined) { if (typeof value !== 'string' || value.length > 1000) throw new CloudError(400, '开票字段过长或格式无效'); request[field] = value.trim() }
    }
    return this.request('/api/billing/invoicing/invoices', 'POST', request)
  }
  withdrawInvoice(id: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new CloudError(400, '无效发票编号')
    return this.request(`/api/billing/invoicing/invoices/${encodeURIComponent(id)}/withdraw`, 'POST')
  }
  changeLabSeats(id: string, seats: number, provider: string): Promise<SeatChange> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id) || !Number.isSafeInteger(seats) || seats < 1 || seats > 100000 || !['wechat', 'alipay'].includes(provider)) throw new CloudError(400, '无效实验室、席位数或支付方式')
    return this.request(`/api/billing/lab/${encodeURIComponent(id)}/seats`, 'POST', { seats, provider })
  }
  reminders(): Promise<unknown> { return this.request('/api/billing/expiry-reminders') }
  manageSubscription(action: 'cancel' | 'uncancel', domain?: string): Promise<unknown> {
    return this.request(`/api/billing/subscription/${action}`, 'POST', domain ? { domain } : {})
  }
}
