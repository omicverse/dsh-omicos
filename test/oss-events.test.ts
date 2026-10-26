import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ScienceService } from '../src/oss/science.js'
import { streamScientificEvents } from '../src/oss/events.js'

it('stops replay while a reader is backpressured and releases timers/listeners on close', () => {
  vi.useFakeTimers()
  const request = new EventEmitter()
  const service = Object.assign(new EventEmitter(), { eventCursor: 3, events: (after: number) => [1,2,3].filter(seq => seq > after).map(seq => ({ seq, type: 'execution/running', data: {} })) })
  const writes: string[] = []
  let accept = false
  const response = Object.assign(new EventEmitter(), { writeHead: () => {}, flushHeaders: () => {}, write: (chunk: string) => { writes.push(chunk); return chunk.includes('hello') || accept }, end: () => {} })
  try {
    streamScientificEvents(request as IncomingMessage, response as unknown as ServerResponse, service as unknown as ScienceService, 0)
    expect(writes).toHaveLength(2) // Opening + one scientific event, then backpressure.
    vi.advanceTimersByTime(5000)
    expect(writes).toHaveLength(2)
    accept = true; response.emit('drain')
    expect(writes.filter(chunk => chunk.includes('event: scientific'))).toHaveLength(3)
    response.emit('close')
    const count = writes.length
    vi.advanceTimersByTime(30000)
    expect(writes).toHaveLength(count)
    expect(service.listenerCount('shutdown')).toBe(0)
  } finally { response.emit('close'); vi.useRealTimers() }
})
