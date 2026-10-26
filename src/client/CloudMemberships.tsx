import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type CloudAccount } from './oss-api.js'
import type { DomainMembership, ExpiryReminder } from '../oss/membership.js'
export const MEMBERSHIP_REFRESH = 'omicos:memberships-refresh'
const label = (domain: string) => domain === 'omics' ? '组学 · omics' : domain === 'humanities_social' ? '人文社科 · humanities_social' : domain || '默认服务域'
const errorText = (error: unknown) => error instanceof ApiError && error.status === 404 ? '当前云服务暂未提供此查询；会员状态未知。' : error instanceof ApiError && error.status === 401 ? '云登录已失效，请重新登录后核对；本地科研不受影响。' : `${error instanceof Error ? error.message : String(error)}；状态未核对，请勿据此重复购买。`
interface ReadState<T> { value?: T; error?: string; checkedAt?: string; loading: boolean }
function useMembershipRead<T>(account: CloudAccount, path: string, visible: boolean) {
  const [state, setState] = useState<ReadState<T>>({ loading: true }); const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  useEffect(() => {
    if (!account.logged_in) { setState({ loading: false }); return }
    if (!visible) return
    const controller = new AbortController(); setState({ loading: true })
    void api<T>(path, undefined, controller.signal, account).then(value => { if (!controller.signal.aborted) setState({ loading: false, value, checkedAt: new Date().toISOString() }) }, error => { if (!controller.signal.aborted) setState({ loading: false, error: errorText(error) }) })
    return () => controller.abort()
  }, [path, visible, account.server, account.generation, account.user?.id, account.logged_in, version])
  useEffect(() => {
    if (!visible || !account.logged_in) return
    const load = () => { if (!document.hidden) refresh() }
    window.addEventListener('focus', load); window.addEventListener(MEMBERSHIP_REFRESH, load); const timer = setInterval(load, 60000)
    return () => { clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener(MEMBERSHIP_REFRESH, load) }
  }, [visible, account.logged_in, refresh])
  return { ...state, refresh }
}
export function CloudRenewalBanner({ account, onRenew }: { account: CloudAccount; onRenew: (domain: string) => void }): JSX.Element | null {
  const result = useMembershipRead<{ reminders: ExpiryReminder[] }>(account, 'reminders', true)
  const [dismissed, setDismissed] = useState<string[]>([])
  if (!account.logged_in) return null
  const reminders = result.value?.reminders.filter(reminder => !dismissed.includes(JSON.stringify(reminder))) || []
  return <section className="oss-renewal" aria-label="云会员到期提醒">{result.error ? <p className="oss-note">到期提醒暂不可核对：{result.error} <button onClick={result.refresh}>重试到期提醒</button></p> : reminders.map(reminder => <div className="oss-renewal-row" key={reminder.domain}><div><strong>{label(reminder.domain)} · {reminder.plan_code}</strong><p>{reminder.state === 'expired' ? '云会员已到期' : `云会员即将到期 · 剩余 ${reminder.days_left} 天`} · {new Date(reminder.expires_at).toLocaleString()}</p><small>以官方会员到期时间为准。本地数据、执行历史与自带模型可继续使用。</small></div><div><button onClick={() => onRenew(reminder.domain)}>查看 {reminder.domain} 续订套餐</button> <button aria-label={`暂不提示 ${reminder.domain}`} onClick={() => setDismissed(value => [...value, JSON.stringify(reminder)])}>暂不提示</button></div></div>)}</section>
}
const kindLabel: Record<string, string> = { monthly: '按月购买', annual: '按年购买', trial: '试用', promo: '活动赠送', admin: '官方授予', seat: '实验室席位' }
export function CloudMemberships({ account, visible, onSelect }: { account: CloudAccount; visible: boolean; onSelect: (domain: string) => void }): JSX.Element {
  const result = useMembershipRead<{ subscriptions: DomainMembership[] }>(account, 'subscriptions', visible)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const manage = async (membership: DomainMembership) => {
    if (busy) return
    const action = membership.cancelled_at ? 'uncancel' : 'cancel'
    if (!window.confirm(`${action === 'cancel' ? '取消' : '恢复'} ${label(membership.domain)} 的 ${membership.plan_code} 后续续订？当前会员有效期为 ${new Date(membership.expires_at).toLocaleString()}，本次不创建付款订单。`)) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api('subscription/manage', { action, domain: membership.domain, confirmed: true }, undefined, account)
      if (alive.current) { setNotice(`${label(membership.domain)} 的操作已由服务端确认，会员状态以最近核对结果为准。`); window.dispatchEvent(new Event(MEMBERSHIP_REFRESH)); result.refresh() }
    } catch (error) { if (alive.current) setError(errorText(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <section className="oss-card oss-memberships" aria-label="各服务域会员"><div className="oss-row"><div><small>OFFICIAL MEMBERSHIPS</small><h2>各服务域会员</h2></div><button disabled={busy || result.loading} onClick={result.refresh}>刷新全部会员</button></div><p>显示官方返回的各域有效会员。试用、赠送和席位权益分别标明；此列表与自带模型、本地科研权限独立。</p>{(error || result.error) && <p role="alert" className="oss-error">{error || result.error}</p>}{notice && <p role="status" className="oss-note">{notice}</p>}{result.loading && <p>正在核对官方会员状态…</p>}{result.value && <>{result.value.subscriptions.length ? <div className="oss-membership-grid">{result.value.subscriptions.map(membership => <article className="oss-membership" key={membership.domain}><small>{label(membership.domain)}</small><h3>{membership.plan_code}</h3><p>{kindLabel[membership.kind || ''] || membership.kind || '来源未标明'}{membership.period_months ? ` · ${membership.period_months} 个月` : ''}</p><p>会员有效期至<br /><time dateTime={membership.expires_at}>{new Date(membership.expires_at).toLocaleString()}</time></p><p>{membership.cancelled_at ? '已取消后续续订；当前有效期仍以服务端为准' : membership.auto_renew === true ? '服务端标记为自动续订' : membership.auto_renew === false ? '未启用自动续订' : '续订方式未标明'}</p><div className="oss-toolbar"><button disabled={busy} onClick={() => onSelect(membership.domain)}>查看 {membership.domain} 套餐</button><button disabled={busy || membership.kind === 'seat' || membership.plan_code === 'community'} onClick={() => void manage(membership)}>{membership.cancelled_at ? '恢复' : '取消'} {membership.domain} 续订</button></div>{membership.kind === 'seat' && <small>席位权益由实验室管理，请联系所有者核对。</small>}</article>)}</div> : <p>官方当前未返回有效会员记录；这不代表所有云端授权均被降级。可刷新或核对所选服务域详情。</p>}<small>最近核对：{result.checkedAt && new Date(result.checkedAt).toLocaleTimeString()}。付款后刷新权益；不会自动重试收费任务。</small></>}</section>
}
