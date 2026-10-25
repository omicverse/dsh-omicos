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
/** Exact offset/chunk identity is immutable. Unknown network outcomes are never automatically retried. */
export async function apiUploadChunk<T>(path: string, bytes: ArrayBuffer, signal?: AbortSignal, retried = false): Promise<T> {
  const response = await fetch(`/omicos/oss/api/${path}`, { method: 'PUT', cache: 'no-store', signal, headers: { 'x-omicos-protocol': '1', 'x-omicos-csrf': csrf, 'content-type': 'application/octet-stream' }, body: bytes })
  const body = await response.json()
  if (response.status === 403 && body.error === 'Invalid CSRF token' && !retried) {
    csrfRefresh ??= request<Session>('session', undefined, signal, true).finally(() => { csrfRefresh = undefined })
    await csrfRefresh
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HOST_REFRESH_EVENT))
    return apiUploadChunk<T>(path, bytes, signal, true)
  }
  if (!response.ok) throw new ApiError(response.status, body.error || `HTTP ${response.status}`)
  return body as T
}
export interface CloudAccount { server?: string; logged_in: boolean; user?: { id: string; email?: string; phone?: string }; generation: number; login?: { user_code: string; verification_uri: string; expires_at: number } }
export interface Session { csrf: string; backend?: 'oss' | 'core'; account: CloudAccount; projects: Array<{ id: string; workspace: string }>; protocol: number }

/** Pure local PDF export: retry only the known pre-dispatch CSRF rejection. */
export async function apiPdf(path:string,data:unknown,signal:AbortSignal,retried=false):Promise<{blob:Blob;sha256:string}>{
 const response=await fetch(`/omicos/oss/api/${path}`,{method:'POST',cache:'no-store',signal,headers:{'x-omicos-protocol':'1','content-type':'application/json','x-omicos-csrf':csrf},body:JSON.stringify(data)})
 if(!response.ok){const error=await response.json();if(response.status===403&&error.error==='Invalid CSRF token'&&!retried){await api<Session>('session',undefined,signal);if(typeof window!=='undefined')window.dispatchEvent(new Event(HOST_REFRESH_EVENT));return apiPdf(path,data,signal,true)}throw new ApiError(response.status,error.error||`HTTP ${response.status}`)}
 if(response.headers.get('content-type')!=='application/pdf')throw new ApiError(502,'PDF export returned an unexpected content type')
 const expected=response.headers.get('x-omicos-export-sha256');if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new ApiError(502,'PDF export digest is missing')
 const blob=await response.blob();if(blob.size>64000000)throw new ApiError(413,'PDF exceeds 64 MB')
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');if(hash!==expected)throw new ApiError(409,'PDF download bytes do not match the export digest')
 return {blob,sha256:hash}
}
