import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ScienceService } from './science.js'

/** Durable SSE invalidations. Event IDs refer to committed project ledger rows. */
export function streamScientificEvents(request: IncomingMessage, response: ServerResponse, service: ScienceService, after: number): void {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid scientific event cursor')
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  response.flushHeaders()
  let cursor = after; let blocked = false; let closed = false
  let timer: ReturnType<typeof setInterval>; let heartbeat: ReturnType<typeof setInterval>
  const cleanup = () => {
    if (closed) return; closed = true
    clearInterval(timer); clearInterval(heartbeat)
    response.off('drain', drain); response.off('close', cleanup); request.off('aborted', close); service.off('shutdown', close)
  }
  const close = () => { if (closed) return; cleanup(); response.end() }
  const drain = () => { blocked = false; pump() }
  const pump = () => {
    if (closed || blocked) return
    try {
      if (cursor > service.eventCursor) { cursor = 0; response.write('id:\nevent: reset\ndata: {"cursor":0}\n\n') }
      for (const event of service.events(cursor, 200)) {
        cursor = event.seq
        if (!response.write(`id: ${event.seq}\nevent: scientific\ndata: ${JSON.stringify(event)}\n\n`)) { blocked = true; return }
      }
    } catch { close() }
  }
  response.on('drain', drain); response.once('close', cleanup); response.once('error', cleanup)
  request.once('aborted', close); service.once('shutdown', close)
  response.write(`event: hello\ndata: ${JSON.stringify({ cursor: service.eventCursor })}\n\n`)
  timer = setInterval(pump, 500)
  heartbeat = setInterval(() => { if (!closed && !blocked && !response.write(': heartbeat\n\n')) blocked = true }, 15000)
  pump()
}
