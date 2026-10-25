let csrf = ''
let accountIdentity: string | undefined
let csrfRefresh: Promise<unknown> | undefined
export const HOST_REFRESH_EVENT = 'omicos:host-refresh'
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const identityOf = (account: CloudAccount) => JSON.stringify([account.server || null, account.logged_in, account.user?.id || null, account.generation ?? 0])
export async function api<T>(path: string, data?: unknown, signal?: AbortSignal, expectedAccount?: CloudAccount): Promise<T> { return request<T>(path, data, signal, false, expectedAccount ? identityOf(expectedAccount) : accountIdentity) }
async function request<T>(path: string, data: unknown, signal: AbortSignal | undefined, retried: boolean, expectedIdentity?: string): Promise<T> {
  const response = await fetch(`/omicos/oss/api/${path}`, { cache: 'no-store', signal, headers: { 'x-omicos-protocol': '1' },
    ...(data === undefined ? {} : { method: 'POST', headers: { 'x-omicos-protocol': '1', 'content-type': 'application/json', 'x-omicos-csrf': csrf, 'x-omicos-account': encodeURIComponent(expectedIdentity || '') }, body: JSON.stringify(data) }) })
  const body = await response.json()
  // This precise rejection occurs before body dispatch, so repeating it cannot duplicate a purchase/execution.
  // Never retry an unknown network result, payment error or arbitrary authorization failure.
  if (response.status === 403 && body.error === 'Invalid CSRF token' && data !== undefined && !retried) {
    csrfRefresh ??= request<Session>('session', undefined, signal, true).finally(() => { csrfRefresh = undefined })
    await csrfRefresh
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HOST_REFRESH_EVENT))
    if (!path.startsWith('project/') && path !== 'open-session-project' && expectedIdentity !== accountIdentity) throw new ApiError(409, '云账号或服务地址已变化，请核对当前账号后重新操作')
    return request<T>(path, data, signal, true, expectedIdentity)
  }
  if (response.status === 409 && body.error === 'Cloud account changed; refresh before submitting') {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HOST_REFRESH_EVENT))
    throw new ApiError(409, '云账号已变化，请核对当前账号后重新提交；本次操作未发送到云端。')
  }
  if (!response.ok) throw new ApiError(response.status, body.error || `HTTP ${response.status}`)
  if (path === 'session') { csrf = body.csrf; accountIdentity = body.account ? identityOf(body.account) : undefined }
  return body as T
}
export interface CloudAccount { server?: string; logged_in: boolean; user?: { id: string; email?: string; phone?: string }; generation: number; login?: { user_code: string; verification_uri: string; expires_at: number } }
export interface Session { csrf: string; backend?: 'oss' | 'core'; account: CloudAccount; projects: Array<{ id: string; workspace: string }>; protocol: number }
