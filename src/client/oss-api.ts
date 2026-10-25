let csrf = ''
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/omicos/oss/api/${path}`, { cache: 'no-store', signal,
    ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': csrf }, body: JSON.stringify(data) }) })
  const body = await response.json()
  if (!response.ok) throw new ApiError(response.status, body.error || `HTTP ${response.status}`)
  if (path === 'session') csrf = body.csrf
  return body as T
}
export interface CloudAccount { logged_in: boolean; user?: { id: string; email?: string; phone?: string }; generation: number; login?: { user_code: string; verification_uri: string; expires_at: number } }
export interface Session { csrf: string; account: CloudAccount; projects: Array<{ id: string; workspace: string }>; protocol: number }
