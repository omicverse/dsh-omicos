import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, writeJson } from './storage.js'

export interface HttpOwnerAuth {
  authorizePage(request: IncomingMessage, response: ServerResponse): boolean
  requestRejection(request: IncomingMessage): number | undefined
}
const equal = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
const originOf = (request: IncomingMessage) => `${'encrypted' in request.socket && request.socket.encrypted === true ? 'https' : 'http'}://${request.headers.host}`
/** Local browser owner authentication. Launch tokens are per-process; signed cookies survive restart. */
export class LocalOwnerAuth implements HttpOwnerAuth {
  readonly launchToken = randomBytes(32).toString('base64url')
  constructor(private secret: Buffer = randomBytes(32)) {}
  static async open(stateDir: string): Promise<LocalOwnerAuth> {
    const path = join(stateDir, 'http-owner.json')
    if (!await readJson<unknown>(path, undefined)) {
      const temporary = join(stateDir, `.http-owner-${randomUUID()}.json`)
      try {
        await writeJson(temporary, { version: 1, secret: randomBytes(32).toString('base64url') })
        try { await link(temporary, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      } finally { await rm(temporary, { force: true }) }
    }
    const stored = await readJson<{ version: number; secret: string } | undefined>(path, undefined)
    if (stored?.version !== 1 || typeof stored.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stored.secret)) throw new Error('Invalid private browser authentication state; preserve it and restore a valid owner credential')
    return new LocalOwnerAuth(Buffer.from(stored.secret, 'base64url'))
  }
  authenticatedUrl(base: string): string { const url = new URL(base); url.searchParams.set('omicos_token', this.launchToken); return url.href }
  private cookieName(origin: string): string { return `omicos-owner-${createHash('sha256').update(origin).digest('hex').slice(0, 12)}` }
  private signature(payload: string): string { return createHmac('sha256', this.secret).update(payload).digest('base64url') }
  requestRejection(request: IncomingMessage): number | undefined {
    const bearer = request.headers.authorization
    if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && equal(bearer.slice(7), this.launchToken)) return undefined
    const origin = originOf(request)
    const name = this.cookieName(origin)
    const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
    if (!cookie || cookie.length > 2048) return 401
    const [body, signature, extra] = cookie.split('.')
    if (!body || !signature || extra !== undefined || !equal(signature, this.signature(body))) return 401
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      return payload.origin === origin && Number.isSafeInteger(payload.expires) && payload.expires > Date.now() ? undefined : 401
    } catch { return 401 }
  }
  authorizePage(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = originOf(request); const url = new URL(request.url || '/', origin)
    if (url.searchParams.has('omicos_token')) {
      const supplied = url.searchParams.get('omicos_token') || ''
      if (!equal(supplied, this.launchToken)) { response.writeHead(401); response.end('Invalid launch credential'); return false }
      const payload = Buffer.from(JSON.stringify({ origin, expires: Date.now() + 30 * 86400 * 1000 })).toString('base64url')
      const secure = origin.startsWith('https:') ? '; Secure' : ''
      response.setHeader('set-cookie', `${this.cookieName(origin)}=${payload}.${this.signature(payload)}; Path=/omicos/oss; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`)
      url.searchParams.delete('omicos_token')
      response.writeHead(303, { location: `${url.pathname}${url.search}${url.hash}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); return false
    }
    if (this.requestRejection(request) === undefined) return true
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('请使用启动命令输出的工作台链接，或先登录 Harness 本地页面。')
    return false
  }
}
