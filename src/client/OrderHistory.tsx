import { useCallback, useEffect, useState } from 'react'
import { api } from './oss-api.js'
import type { OrderSummary } from '../oss/orders.js'
import type { RecoveredOrder } from '../oss/commerce-types.js'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function OrderHistory({ version, onOpen }: { version: number; onOpen: (order: RecoveredOrder) => void }): JSX.Element {
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [next, setNext] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (before?: string, signal?: AbortSignal) => {
    const result = await api<{ orders: OrderSummary[]; next?: string }>(`orders${before ? `?before=${encodeURIComponent(before)}` : ''}`, undefined, signal)
    if (signal?.aborted) return
    setOrders(previous => before ? previous.concat(result.orders) : result.orders); setNext(result.next); setError('')
  }, [])
  useEffect(() => { const controller = new AbortController(); void load(undefined, controller.signal).catch(error => { if (!controller.signal.aborted) setError(message(error)) }); return () => controller.abort() }, [load, version])
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  return <article className="oss-card" aria-label="本地订单记录"><div className="oss-row"><h2>本地订单记录</h2><button disabled={busy} onClick={() => void run(() => load())}>刷新订单记录</button></div><p>保存此设备创建的订阅与席位补款订单。按云端地址和账号隔离；重新打开订单时先向官方查询，成功后才恢复可用的付款二维码。历史状态是上次查询结果，不代表当前权益。</p>
    {error && <p role="alert" className="oss-error">{error}</p>}
    {orders.length === 0 && <p>此账号在本设备暂无已保存的订单。其他设备或早期版本创建的订单，可在下方按编号查询。</p>}
    <div className="oss-table-wrap"><table><caption>当前账号 · 本设备订单</caption><thead><tr><th>订单</th><th>金额</th><th>上次状态</th><th>操作</th></tr></thead><tbody>{orders.map(order => <tr key={order.order_no}><td><code>{order.order_no}</code><br /><small>{order.source === 'lab-seats' ? '实验室席位补款' : '订阅购买'} · {new Date(order.created_at).toLocaleString()}</small></td><td>{order.currency} {order.amount_rmb}</td><td>{order.status === 'unverified' ? '尚未查询' : order.status}{order.checked_at && <><br /><small>{new Date(order.checked_at).toLocaleString()}</small></>}</td><td><button aria-label={`重新打开订单 ${order.order_no}`} disabled={busy} onClick={() => void run(async () => { const result = await api<RecoveredOrder>(`order/reopen?id=${encodeURIComponent(order.order_no)}`); onOpen(result); await load() })}>重新打开</button></td></tr>)}</tbody></table></div>
    {next && <button disabled={busy} onClick={() => void run(() => load(next))}>加载更早订单</button>}
  </article>
}
