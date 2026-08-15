import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@omicverse/omicos-protocol'
import { ActivityMirror, type ActivitySnapshot } from '../src/host/activity.js'

function ev<T extends object>(payload: T): StreamEvent {
  return { seq: 0, ...payload } as unknown as StreamEvent
}

function mirror(opts: { throttleMs?: number } = {}): { m: ActivityMirror; out: ActivitySnapshot[]; clock: { t: number } } {
  const out: ActivitySnapshot[] = []
  const clock = { t: 0 }
  const m = new ActivityMirror((s) => out.push(s), { throttleMs: opts.throttleMs ?? 300, now: () => clock.t })
  return { m, out, clock }
}

describe('ActivityMirror', () => {
  it('structural transitions emit immediately: tool start -> exec line -> back to thinking -> done', () => {
    const { m, out } = mirror()
    m.consume(ev({ type: 'tool_started', tool_name: 'run_python_code', started_at: 1 }))
    m.consume(ev({ type: 'exec_line', line_start: 1, line_end: 3 }))
    m.consume(ev({ type: 'step', content: { role: 'assistant', content: 'thought' } }))
    m.consume(ev({ type: 'done' }))

    expect(out.map((s) => s.phase)).toEqual(['tool', 'tool', 'thinking', 'done'])
    expect(out[0]).toMatchObject({ n: 1, tool: 'run_python_code' })
    expect(out[1]!.execLines).toEqual({ start: 1, end: 3 })
    expect(out[2]!.tool).toBeUndefined()
    expect(out[3]).toMatchObject({ outcome: 'ok' })
  })

  it('every snapshot is independently renderable (full state, not a delta)', () => {
    const { m, out, clock } = mirror()
    m.consume(ev({ type: 'tool_started', tool_name: 'run_python_code', started_at: 1 }))
    m.consume(ev({ type: 'progress', bar_id: 'b1', label: 'UMAP', current: 1, percent: 10, elapsed: 1, unit: 'it', done: false }))
    clock.t = 1000
    m.consume(ev({ type: 'tool_output_chunk', chunk: 'epoch 1\n' }))
    const last = out[out.length - 1]!
    // The stdout emission still carries tool + progress state.
    expect(last).toMatchObject({ phase: 'tool', tool: 'run_python_code' })
    expect(last.progress).toEqual(['UMAP 10%'])
    expect(last.stdoutTail).toBe('epoch 1\n')
  })

  it('chatty stdout/progress is throttled; structural changes bypass the throttle', () => {
    const { m, out, clock } = mirror({ throttleMs: 300 })
    m.consume(ev({ type: 'tool_started', tool_name: 'run_python_code', started_at: 1 })) // emit 1 (t=0)
    for (let i = 0; i < 10; i++) m.consume(ev({ type: 'tool_output_chunk', chunk: `${i}\n` })) // all within t=0
    expect(out).toHaveLength(1)
    expect(m.hasPending).toBe(true)

    clock.t = 301
    m.consume(ev({ type: 'tool_output_chunk', chunk: 'x\n' })) // emit 2
    expect(out).toHaveLength(2)
    expect(out[1]!.stdoutTail).toContain('x')

    m.consume(ev({ type: 'exec_line', line_start: 5, line_end: 5 })) // structural: immediate
    expect(out).toHaveLength(3)
  })

  it('flushPending emits the coalesced tail exactly once', () => {
    const { m, out } = mirror({ throttleMs: 1000 })
    m.consume(ev({ type: 'tool_started', tool_name: 't', started_at: 1 }))
    m.consume(ev({ type: 'tool_output_chunk', chunk: 'tail' }))
    expect(out).toHaveLength(1)
    m.flushPending()
    expect(out).toHaveLength(2)
    expect(out[1]!.stdoutTail).toBe('tail')
    m.flushPending()
    expect(out).toHaveLength(2)
  })

  it('stdout tail is bounded and reset per tool', () => {
    const out: ActivitySnapshot[] = []
    const m = new ActivityMirror((s) => out.push(s), { throttleMs: 0, stdoutTailChars: 8, now: () => 1e9 })
    m.consume(ev({ type: 'tool_started', tool_name: 'a', started_at: 1 }))
    m.consume(ev({ type: 'tool_output_chunk', chunk: '0123456789' }))
    expect(out[out.length - 1]!.stdoutTail).toBe('23456789')
    m.consume(ev({ type: 'tool_started', tool_name: 'b', started_at: 2 }))
    expect(out[out.length - 1]!.stdoutTail).toBeUndefined()
  })

  it('child-agent events are ignored; error/cancel map to terminal outcomes; finish is idempotent', () => {
    const { m, out } = mirror()
    m.consume(ev({ type: 'tool_started', tool_name: 'child', started_at: 1, execution_context_id: 'ec1' }))
    expect(out).toHaveLength(0)

    m.consume(ev({ type: 'error', content: 'boom' }))
    expect(out[out.length - 1]).toMatchObject({ phase: 'done', outcome: 'error', error: 'boom' })

    m.finish()
    m.consume(ev({ type: 'tool_started', tool_name: 'late', started_at: 2 }))
    expect(out).toHaveLength(1)

    const cancelled = mirror()
    cancelled.m.consume(ev({ type: 'done', reason: 'cancelled' }))
    expect(cancelled.out[0]).toMatchObject({ outcome: 'cancelled' })
  })

  it('snapshot sequence n is monotonic (stable business-id material)', () => {
    const { m, out, clock } = mirror({ throttleMs: 0 })
    m.consume(ev({ type: 'tool_started', tool_name: 'a', started_at: 1 }))
    clock.t += 1
    m.consume(ev({ type: 'tool_output_chunk', chunk: 'x' }))
    clock.t += 1
    m.consume(ev({ type: 'done' }))
    expect(out.map((s) => s.n)).toEqual([1, 2, 3])
  })
})
