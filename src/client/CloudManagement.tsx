import { useState } from 'react'
import { api, type CloudAccount } from './oss-api.js'
import type { InvoicingSummary, InvoiceRequest, LabSummary, LabPricing, PaymentOrder, SeatChange } from '../oss/commerce-types.js'

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`
export function CloudManagement({ userId, onOrder, account }: { account: CloudAccount; userId: string; onOrder: (order: PaymentOrder) => void }): JSX.Element {
  const scopedApi = <T,>(path: string, data?: unknown, signal?: AbortSignal) => api<T>(path, data, signal, account)
  const [tab, setTab] = useState<'invoices' | 'labs'>()
  const [summary, setSummary] = useState<InvoicingSummary>()
  const [labs, setLabs] = useState<LabSummary[]>([])
  const [pricing, setPricing] = useState<LabPricing>()
  const [selected, setSelected] = useState<string[]>([])
  const [form, setForm] = useState<InvoiceRequest>({ order_nos: [], buyer_type: 'personal', buyer_title: '', invoice_kind: 'normal' })
  const [labId, setLabId] = useState('')
  const [seats, setSeats] = useState(3)
  const [provider, setProvider] = useState('wechat')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const loadInvoices = async () => { const result = await scopedApi<InvoicingSummary>('invoicing'); setSummary(result); setSelected([]) }
  const loadLabs = async () => {
    const [result, prices] = await Promise.all([scopedApi<{ labs: LabSummary[] }>('labs'), scopedApi<LabPricing>('lab-pricing')])
    setLabs(result.labs); setPricing(prices)
    const first = result.labs.find(lab => lab.owner_id === userId)
    if (!labId && first) { setLabId(first.id); setSeats(first.seat_quota) }
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const switchTab = (next: 'invoices' | 'labs') => void run(async () => { setTab(next); if (next === 'invoices') await loadInvoices(); else await loadLabs() })
  const invoiceTotal = summary?.orders.filter(order => selected.includes(order.order_no) && !order.invoiced).reduce((sum, order) => sum + order.amount_rmb_cents, 0) || 0
  const threshold = form.invoice_kind === 'special' ? summary?.min_special_invoice_cents ?? summary?.min_invoice_cents ?? 0 : summary?.min_invoice_cents ?? 0
  const limitReached = Boolean(summary && summary.daily_limit > 0 && summary.submitted_today >= summary.daily_limit)
  const applyInvoice = () => {
    if (!window.confirm(`确认针对所选 ${selected.length} 笔已付款订单申请 ${money(invoiceTotal)} 发票？请核对抬头和税号。`)) return
    void run(async () => { await scopedApi('invoice', { confirmed: true, invoice: { ...form, order_nos: selected } }); await loadInvoices(); setNotice('申请已提交，等待官方开具。') })
  }
  return <section className="oss-card oss-management"><div className="oss-row"><h2>账单与实验室</h2><div><button disabled={busy} aria-pressed={tab === 'invoices'} onClick={() => switchTab('invoices')}>付款记录与发票</button><button disabled={busy} aria-pressed={tab === 'labs'} onClick={() => switchTab('labs')}>实验室席位</button></div></div>
    {error && <p role="alert" className="oss-error">{error}</p>}{notice && <p role="status" className="oss-note">{notice}</p>}
    {tab === 'invoices' && summary && <><p>已支付 {money(summary.paid_cents)} · 已占用开票额度 {money(summary.invoiced_cents)} · 可开票 {money(summary.remaining_cents)}</p><div className="oss-table-wrap"><table><caption>已付款订单，由服务端核对可开票状态</caption><thead><tr><th>选择</th><th>订单</th><th>服务</th><th>金额</th><th>付款日期</th><th>开票状态</th></tr></thead><tbody>{summary.orders.map(order => <tr key={order.order_no}><td><input type="checkbox" aria-label={`选择订单 ${order.order_no}`} disabled={order.invoiced || busy} checked={selected.includes(order.order_no)} onChange={event => setSelected(current => event.target.checked ? [...current, order.order_no] : current.filter(id => id !== order.order_no))} /></td><td><code>{order.order_no}</code></td><td>{order.domain || '默认'} / {order.plan_code}</td><td>{money(order.amount_rmb_cents)}</td><td>{new Date(order.paid_at).toLocaleDateString()}</td><td>{order.invoiced ? '已开票或申请中' : '可申请'}</td></tr>)}</tbody></table></div>
    <form onSubmit={event => { event.preventDefault(); applyInvoice() }}><h3>申请发票</h3><div className="oss-form-grid"><label>购买方类型<select aria-label="购买方类型" value={form.buyer_type} onChange={event => setForm(current => ({ ...current, buyer_type: event.target.value as 'personal' | 'company', invoice_kind: 'normal' }))}><option value="personal">个人</option><option value="company">企业</option></select></label><label>发票类型<select aria-label="发票类型" value={form.invoice_kind} onChange={event => setForm(current => ({ ...current, invoice_kind: event.target.value as 'normal' | 'special' }))}><option value="normal">普通发票</option>{form.buyer_type === 'company' && <option value="special">增值税专用发票</option>}</select></label><label>发票抬头<input required maxLength={200} value={form.buyer_title} onChange={event => setForm(current => ({ ...current, buyer_title: event.target.value }))} /></label><label>接收邮箱<input type="email" value={form.buyer_email || ''} onChange={event => setForm(current => ({ ...current, buyer_email: event.target.value }))} /></label>{form.buyer_type === 'company' && <label>纳税人识别号<input required maxLength={100} value={form.buyer_tax_id || ''} onChange={event => setForm(current => ({ ...current, buyer_tax_id: event.target.value }))} /></label>}{form.invoice_kind === 'special' && (['buyer_address', 'buyer_phone', 'buyer_bank', 'buyer_bank_account'] as const).map((field, index) => <label key={field}>{['注册地址', '注册电话', '开户银行', '银行账号'][index]}<input required maxLength={200} value={form[field] || ''} onChange={event => setForm(current => ({ ...current, [field]: event.target.value }))} /></label>)}<label>备注<input maxLength={1000} value={form.remark || ''} onChange={event => setForm(current => ({ ...current, remark: event.target.value }))} /></label></div><p>已选择 {selected.length} 笔，合计 {money(invoiceTotal)}。本类型最低开票金额 {money(threshold)}。{summary.daily_limit > 0 ? `今日已申请 ${summary.submitted_today}/${summary.daily_limit} 次。` : ''}</p><button className="oss-primary" type="submit" disabled={busy || !selected.length || !form.buyer_title.trim() || invoiceTotal < threshold || limitReached}>核对并申请发票</button></form>
    <h3>开票记录</h3>{summary.invoices.map(invoice => <div key={invoice.id} className="oss-variable"><div className="oss-row"><span>{invoice.buyer_title} · {money(invoice.amount_rmb_cents)}</span><span>{invoice.status === 'issued' ? '已开具' : invoice.status === 'pending' ? '申请中' : '已作废'}</span></div><small>{invoice.invoice_no || invoice.id}</small>{invoice.status === 'pending' && <button disabled={busy} onClick={() => { if (window.confirm('撤回这笔尚未开具的申请？撤回不会恢复今日申请次数。')) void run(async () => { await scopedApi('invoice/withdraw', { id: invoice.id, confirmed: true }); await loadInvoices(); setNotice('申请已撤回，可开票状态已刷新。') }) }}>撤回申请</button>}</div>)}</>}
    {tab === 'labs' && <><p>仅实验室所有者可调整席位，最终资格与金额由官方服务端核对。扩容可能生成补款订单；缩减不退款。</p>{pricing && <p>至少 {pricing.min_seats} 席 · 月付 ¥{pricing.seat_price_monthly_rmb}/席 · 年付 ¥{pricing.seat_price_yearly_rmb}/席</p>}{labs.length === 0 ? <p>当前账号暂无实验室。可通过上方 Lab 套餐创建并购买。</p> : <><div className="oss-form-grid"><label>实验室<select aria-label="实验室" value={labId} onChange={event => { const id = event.target.value; setLabId(id); setSeats(labs.find(lab => lab.id === id)?.seat_quota || 1) }}>{labs.map(lab => <option key={lab.id} value={lab.id}>{lab.name} · {lab.seat_quota} 席{lab.owner_id !== userId ? '（成员）' : ''}</option>)}</select></label><label>新的总席位数<input type="number" min={pricing?.min_seats || 1} value={seats} onChange={event => setSeats(Number(event.target.value))} /></label><label>补款方式<select aria-label="补款方式" value={provider} onChange={event => setProvider(event.target.value)}><option value="wechat">微信支付</option><option value="alipay">支付宝</option></select></label></div><button disabled={busy || !labId || labs.find(lab => lab.id === labId)?.owner_id !== userId || !Number.isSafeInteger(seats) || seats < (pricing?.min_seats || 1)} onClick={() => { if (window.confirm(`将实验室总席位数调整为 ${seats}？扩容将按服务端规则生成补款订单，缩减不退款。`)) void run(async () => { const result = await scopedApi<SeatChange>('lab/seats', { labId, seats, provider, confirmed: true }); if (result.order_no) { if (typeof result.amount_rmb !== 'number' || !result.pay_url || !result.expires_at || !result.currency || !result.provider) throw new Error('补款订单信息不完整，请保留编号并联系官方'); onOrder(result as PaymentOrder); setNotice('补款订单已生成，请在付款区域扫码；支付后刷新席位状态。') } else { await loadLabs(); setNotice(result.message || '席位调整已由服务端确认。') } }) }}>确认席位调整</button></>}</>}
  </section>
}
