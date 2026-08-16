// In-process HTTP mock for the omicOS-server / omicos-core auth endpoints
// exercised by test/auth.spec.ts and test/figures.spec.ts. Binds to
// 127.0.0.1 on an ephemeral (OS-chosen) port — never a real network host,
// per house rules. Not part of the package's public API; test-only.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'

export interface MockAuthRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  /** Parsed JSON body, or `undefined` for an empty/non-JSON body (e.g. every `GET`). */
  json: unknown
}

export interface MockAuthResponseSpec {
  status: number
  headers?: Record<string, string>
  /** JSON-serialized as the response body. Mutually exclusive with `body` — set at most one. */
  json?: unknown
  /** Raw bytes for the response body (e.g. `files/preview`'s non-JSON contract). Mutually exclusive with `json`. */
  body?: Uint8Array
  /** Milliseconds to wait before responding — for scenarios exercising a poll timeout (the WeChat qr-poll's real ~25s server-side long-poll, faked short in tests). */
  delayMs?: number
}

export type MockAuthHandler = (
  req: MockAuthRequest
) => MockAuthResponseSpec | Promise<MockAuthResponseSpec>

/**
 * Routes are keyed `"<METHOD> <path>"` (e.g. `"POST /api/auth/cli-poll"`);
 * the same handler answers every request to that method+path regardless
 * of query string or body, so a scenario needing different behavior
 * per-call (pending -> approved, first device code expires, etc.) keeps
 * its own counter/state in the closure it registers as the handler.
 *
 * `requests` accumulates every request this server has seen, in arrival
 * order, so a test can assert call counts / header values / body shapes
 * after the fact (e.g. `pushLoginToCore`'s `X-OmicOS-Origin` header, the
 * two distinct `device_code`s in an expired -> re-mint scenario, or the
 * exact `path` query string `fetchFilePreview` sent for a CJK path).
 */
export class MockAuthServer {
  private readonly server: Server
  private readonly routes: Map<string, MockAuthHandler>
  readonly requests: MockAuthRequest[] = []
  baseUrl = ''

  constructor(routes: Record<string, MockAuthHandler>) {
    this.routes = new Map(Object.entries(routes))
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
        }
        res.end(JSON.stringify({ error: String(err) }))
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A test that deliberately aborts a slow request (the WeChat
    // pollTimeoutMs scenarios) tears down the client socket while this
    // handler is still awaiting `spec.delayMs` — the eventual `res.end()`
    // then races an already-closed connection. That is expected, not a
    // test failure: swallow the write-after-abort error instead of letting
    // it become an unhandled 'error' event on the response stream.
    res.on('error', () => {})
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    const rawBody = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let json: unknown
    if (rawBody.length > 0) {
      try {
        json = JSON.parse(rawBody.toString('utf8'))
      } catch {
        json = undefined
      }
    }
    const mockReq: MockAuthRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      json,
    }
    this.requests.push(mockReq)

    const key = `${mockReq.method} ${mockReq.path}`
    const handler = this.routes.get(key)
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `no mock route registered for ${key}` }))
      return
    }

    const spec = await handler(mockReq)
    if (spec.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
    }
    if (res.destroyed || res.writableEnded) {
      // Client already tore down the connection during the delay (an
      // aborted poll-timeout test) — nothing left to write to.
      return
    }
    const headers = { ...(spec.headers ?? {}) }
    if (spec.body !== undefined) {
      res.writeHead(spec.status, headers)
      res.end(Buffer.from(spec.body))
      return
    }
    headers['content-type'] ??= 'application/json'
    res.writeHead(spec.status, headers)
    res.end(spec.json === undefined ? '' : JSON.stringify(spec.json))
  }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('mock auth server failed to bind a TCP port')
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
