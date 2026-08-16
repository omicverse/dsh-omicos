// In-process HTTP mock for omicos-core's chat-surface endpoints, exercised
// by test/turn.spec.ts and test/conversations.spec.ts. Binds to
// 127.0.0.1 on an ephemeral (OS-chosen) port — never a real network host,
// per house rules. Not part of the package's public API; test-only.
//
// Deliberately lower-level than a "return a response spec" mock (compare
// `mockAuthServer.ts`, which suits the auth surface's one-shot-response
// endpoints): SSE scenarios need a handler that keeps `res` open, writes
// frames incrementally over time, coordinates with a LATER request on a
// different route (tool-approval unblocking a paused chat-stream write),
// or deliberately never calls `res.end()` at all (the watchdog-silence
// scenario) — so handlers here get the raw `ServerResponse` and full
// control over its lifecycle instead of a declarative spec object.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'

export interface MockCoreRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  /** Parsed JSON body, or `undefined` for an empty/non-JSON body (e.g. every `GET`). */
  json: unknown
}

export type MockCoreHandler = (req: MockCoreRequest, res: ServerResponse) => void | Promise<void>

/**
 * Routes are keyed `"<METHOD> <path>"` (e.g. `"POST /api/agent/chat/
 * stream"`) — exact pathname match, query string ignored for ROUTING
 * (read it off `req.query` inside the handler; that's how the attach
 * scenarios read `since_seq`). `on()` replaces any existing handler for
 * the same key, so a test can rewire a route mid-scenario if needed.
 *
 * `requests` accumulates every request this server has seen, in arrival
 * order, so a test can assert header values (the runtime/session headers
 * every real request must carry) / body shapes / call counts after the
 * fact.
 */
export class MockCore {
  private readonly server: Server
  private readonly routes = new Map<string, MockCoreHandler>()
  readonly requests: MockCoreRequest[] = []
  baseUrl = ''

  constructor() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        if (!res.writableEnded) res.end(JSON.stringify({ error: String(err) }))
      })
    })
  }

  on(method: string, path: string, handler: MockCoreHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A watchdog-timeout test aborts the client side while a handler is
    // deliberately holding `res` open forever — the eventual teardown then
    // races an already-closed connection. Expected, not a test failure:
    // swallow the write-after-abort error instead of an unhandled 'error'.
    res.on('error', () => {})
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let json: unknown
    if (raw.length > 0) {
      try {
        json = JSON.parse(raw.toString('utf8'))
      } catch {
        json = undefined
      }
    }
    const mockReq: MockCoreRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      json,
    }
    this.requests.push(mockReq)

    const handler = this.routes.get(`${mockReq.method} ${mockReq.path}`)
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `no mock route registered for ${mockReq.method} ${mockReq.path}` }))
      return
    }
    await handler(mockReq, res)
  }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('mock core server failed to bind a TCP port')
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
    // Force-terminate any lingering connection (e.g. the watchdog-silence
    // scenario's deliberately-never-`.end()`ed response) so `close()`
    // never hangs the test suite waiting for a socket that will never
    // close on its own.
    this.server.closeAllConnections?.()
    await closed
  }
}

// ---------------------------------------------------------------------------
// SSE response helpers
// ---------------------------------------------------------------------------

export interface SseFixtureFrame {
  data: unknown
  id?: number
}

/** Sets SSE response headers — call once per stream before writing any frames. */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

/**
 * Writes one frame in exactly the shape core puts on the wire:
 * `data: <json>\nid: <n>\n\n`, with the `id:` line omitted entirely when
 * `frame.id` is absent — matching a real heartbeat frame (server.rs:
 * 4365-4366's bare `Event::default().data(heartbeat)`, no `.id()` call)
 * as distinct from a real event frame (server.rs:4334, always `.id(seq)`).
 */
export function writeSseFrame(res: ServerResponse, frame: SseFixtureFrame): void {
  let payload = `data: ${JSON.stringify(frame.data)}\n`
  if (frame.id !== undefined) payload += `id: ${frame.id}\n`
  payload += '\n'
  res.write(payload)
}

export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// Turn event fixtures — protocol-shaped, matching the envelope splice
// `sse_seq_response` actually performs (server.rs:4284-4379).
// ---------------------------------------------------------------------------

export interface TurnFixtureOptions {
  turnId?: string
  requestId?: string
  runtimeUid?: string
  /** First frame's `id:`/`event_seq` — default 1. */
  startSeq?: number
}

/**
 * The full frame sequence for one ordinary, cleanly-completed turn:
 * request_accepted, turn_started, three llm_chunks, step, tool_started,
 * tool_output_chunk, exec_line, progress, usage, done — exactly the
 * variant list DESIGN.md's task brief calls out. Every frame after
 * `turn_started` carries `turn_id` (server.rs:4322-4324, `map.entry
 * ("turn_id").or_insert_with` fires once `active_turn_id` is `Some`); the
 * `done` frame additionally carries `persisted_through_seq` equal to its
 * own seq (server.rs:4325-4331: only on a `done` whose `reason` isn't
 * `"error"`). IDs are sequential starting at `startSeq` (default 1) with
 * no gaps — a scenario simulating a mid-stream cut just serves a PREFIX
 * of this array and lets the attach handler serve the matching suffix by
 * filtering on `id >= since_seq`.
 */
export function fixtureTurn(sessionId: string, opts: TurnFixtureOptions = {}): SseFixtureFrame[] {
  const turnId = opts.turnId ?? 'turn_1'
  const requestId = opts.requestId ?? 'req_1'
  const runtimeUid = opts.runtimeUid ?? 'runtime_test'
  let seq = opts.startSeq ?? 1
  const frames: SseFixtureFrame[] = []
  const push = (extra: Record<string, unknown>, withTurnId: boolean): void => {
    frames.push({
      data: {
        session_id: sessionId,
        request_id: requestId,
        runtime_uid: runtimeUid,
        connection_epoch: null,
        event_seq: seq, // server.rs:4321 unconditionally inserts this on every frame
        ...(withTurnId ? { turn_id: turnId } : {}),
        ...extra,
      },
      id: seq,
    })
    seq += 1
  }
  push({ type: 'request_accepted', accepted_at: 1_700_000_000 }, false)
  push({ type: 'turn_started', turn_id: turnId, started_at: 1_700_000_001 }, false)
  push({ type: 'llm_chunk', content: 'Hello' }, true)
  push({ type: 'llm_chunk', content: ', ' }, true)
  push({ type: 'llm_chunk', content: 'world' }, true)
  push({ type: 'step', content: { note: 'thinking' } }, true)
  push({ type: 'tool_started', tool_name: 'run_python_code', tool_call_id: 'call_1', started_at: 1_700_000_002 }, true)
  push({ type: 'tool_output_chunk', chunk: 'print output', tool_call_id: 'call_1' }, true)
  push({ type: 'exec_line', line_start: 1, line_end: 3, tool_call_id: 'call_1' }, true)
  push(
    { type: 'progress', bar_id: 'bar_1', label: 'processing', current: 5, total: 10, percent: 50, elapsed: 1.2, unit: 'it', done: true },
    true,
  )
  push({ type: 'usage', content: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }, true)
  push({ type: 'done', persisted_through_seq: seq }, true)
  return frames
}

/**
 * The 8s-interval liveness frame (server.rs:4354-4372) — note it has NO
 * `id:` line (unlike every real event), so a watchdog test that wants
 * heartbeats to keep a connection alive without advancing `lastSeq` uses
 * this rather than a real event frame.
 */
export function heartbeatFrame(
  sessionId: string,
  opts: { requestId?: string; runtimeUid?: string; turnId?: string | null; eventSeq?: number | null } = {},
): SseFixtureFrame {
  return {
    data: {
      type: 'heartbeat',
      state: 'running',
      runtime_uid: opts.runtimeUid ?? 'runtime_test',
      connection_epoch: null,
      session_id: sessionId,
      request_id: opts.requestId ?? 'req_1',
      turn_id: opts.turnId ?? null,
      event_seq: opts.eventSeq ?? null,
    },
  }
}
