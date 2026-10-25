import { CloudError } from './cloud-error.js'
export interface DomainMembership { domain: string; plan_code: string; expires_at: string; started_at?: string; auto_renew?: boolean; cancelled_at?: string | null; period_months?: number; kind?: string }
export interface ExpiryReminder { domain: string; plan_code: string; expires_at: string; state: 'expired' | 'expiring_soon'; days_left: number; auto_renew?: boolean; cancelled_at?: string | null }
export function billingDomain(value: unknown): string | undefined { if (value === undefined || value === '') return; if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new CloudError(400, '无效服务域'); return value }
const field = (value: unknown, name: string): string => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new CloudError(502, `云端订阅 ${name} 格式不可核对`); return value }
const date = (value: unknown, name: string): string => { if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) throw new CloudError(502, `云端会员 ${name} 不可核对`); return value }
function common(input: any): DomainMembership {
  if (!input || typeof input !== 'object') throw new CloudError(502, '云端会员记录不可核对')
  const result: DomainMembership = { domain: field(input.domain, 'domain'), plan_code: field(input.plan_code, 'plan_code'), expires_at: date(input.expires_at, 'expires_at') }
  if (input.auto_renew !== undefined && input.auto_renew !== null) { if (typeof input.auto_renew !== 'boolean' && input.auto_renew !== 0 && input.auto_renew !== 1) throw new CloudError(502, '云端续订状态不可核对'); result.auto_renew = input.auto_renew === true || input.auto_renew === 1 }
  if (input.cancelled_at !== undefined) result.cancelled_at = input.cancelled_at === null ? null : date(input.cancelled_at, 'cancelled_at')
  return result
}
function rows(input: any, key: string): any[] { if (!input || !Array.isArray(input[key]) || input[key].length > 500) throw new CloudError(502, '云端会员列表不可核对；不能将查询失败视为没有订阅'); if (new Set(input[key].map((row: any) => row?.domain)).size !== input[key].length) throw new CloudError(502, '云端会员服务域重复，请刷新核对'); return input[key] }
export function memberships(input: unknown): { subscriptions: DomainMembership[] } {
  return { subscriptions: rows(input, 'subscriptions').map(input => { const result = common(input); if (input.started_at !== undefined) result.started_at = date(input.started_at, 'started_at'); if (input.kind !== undefined) result.kind = field(input.kind, 'kind'); if (input.period_months !== undefined) { if (!Number.isSafeInteger(input.period_months) || input.period_months < 0 || input.period_months > 1200) throw new CloudError(502, '云端会员周期不可核对'); result.period_months = input.period_months } return result }) }
}
export function expiryReminders(input: unknown): { reminders: ExpiryReminder[] } {
  return { reminders: rows(input, 'reminders').map(input => { const result = common(input); if (!['expired', 'expiring_soon'].includes(input.state) || !Number.isSafeInteger(input.days_left) || input.days_left < 0 || input.days_left > 365000) throw new CloudError(502, '云端会员提醒状态不可核对'); return { ...result, state: input.state, days_left: input.days_left } }) }
}
