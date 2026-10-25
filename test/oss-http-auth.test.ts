import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LocalOwnerAuth } from '../src/oss/http-auth.js'

const request = (url = '/omicos/oss', headers: Record<string, string> = {}) => ({ url, headers: { host: '127.0.0.1:8123', ...headers }, socket: {} }) as IncomingMessage
const response = () => {
  const headers: Record<string, any> = {}; let status = 0
  const value = { setHeader: (key: string, item: any) => { headers[key] = item }, writeHead: (code: number, items?: any) => { status = code; Object.assign(headers, items) }, end: () => {} }
  return { value: value as unknown as ServerResponse, headers, status: () => status }
}
describe('local workbench owner credentials', () => {
  it('requires owner authentication and strips launch credentials before serving the page', () => {
    const auth = new LocalOwnerAuth()
    expect(auth.requestRejection(request())).toBe(401)
    const invalid = response()
    expect(auth.authorizePage(request('/omicos/oss?omicos_token=wrong'), invalid.value)).toBe(false)
    expect(invalid.status()).toBe(401)
    const launch = new URL(auth.authenticatedUrl('http://127.0.0.1:8123/omicos/oss?project=abc'))
    const redirect = response()
    expect(auth.authorizePage(request(launch.pathname + launch.search), redirect.value)).toBe(false)
    expect(redirect.status()).toBe(303)
    expect(redirect.headers.location).toBe('/omicos/oss?project=abc')
    expect(redirect.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict')
    const cookie = redirect.headers['set-cookie'].split(';')[0]
    expect(auth.requestRejection(request(undefined, { cookie }))).toBeUndefined()
    expect(auth.requestRejection(request(undefined, { cookie: cookie + 'x' }))).toBe(401)
    expect(auth.requestRejection(request(undefined, { cookie, host: '127.0.0.1:8124' }))).toBe(401)
    expect(auth.requestRejection(request(undefined, { authorization: `Bearer ${auth.launchToken}` }))).toBeUndefined()
  })
  it('expires cookies and binds secure cookies to their exact origin', () => {
    const auth = new LocalOwnerAuth()
    const redirect = response()
    const secure = request(`/omicos/oss?omicos_token=${auth.launchToken}`)
    Object.assign(secure.socket, { encrypted: true })
    auth.authorizePage(secure, redirect.value)
    expect(redirect.headers['set-cookie']).toContain('; Secure')
    const cookie = redirect.headers['set-cookie'].split(';')[0]
    expect(auth.requestRejection(request(undefined, { cookie }))).toBe(401)
    secure.url = '/omicos/oss'; secure.headers.cookie = cookie
    expect(auth.requestRejection(secure)).toBeUndefined()
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400 * 1000)
    try { expect(auth.requestRejection(secure)).toBe(401) } finally { time.mockRestore() }
  })
  it('preserves signed browser access across restart with private state and rotates launch tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oss-owner-'))
    try {
      const first = await LocalOwnerAuth.open(directory)
      const redirect = response()
      first.authorizePage(request(`/omicos/oss?omicos_token=${first.launchToken}`), redirect.value)
      const second = await LocalOwnerAuth.open(directory)
      expect(second.launchToken).not.toBe(first.launchToken)
      expect(second.requestRejection(request(undefined, { authorization: `Bearer ${first.launchToken}` }))).toBe(401)
      expect(second.requestRejection(request(undefined, { cookie: redirect.headers['set-cookie'].split(';')[0] }))).toBeUndefined()
      expect((await stat(join(directory, 'http-owner.json'))).mode & 0o777).toBe(0o600)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
