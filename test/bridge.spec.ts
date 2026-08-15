import { describe, expect, it } from 'vitest'
import type { ProgressEvent, StreamEvent } from '@omicverse/omicos-protocol'
import { TurnAccumulator, formatProgress } from '../src/host/bridge.js'

/** Envelope fields every real frame carries; tests only care about the variant payloads. */
function ev<T extends object>(payload: T): StreamEvent {
  return { seq: 0, ...payload } as unknown as StreamEvent
}

function runThrough(events: StreamEvent[]): TurnAccumulator {
  const acc = new TurnAccumulator()
  for (const e of events) acc.consume(e)
  return acc
}

describe('TurnAccumulator', () => {
  it('a final assistant step REPLACES accumulated llm_chunk text (authoritative echo, store parity)', () => {
    const acc = runThrough([
      ev({ type: 'llm_chunk', content: 'draft that will be superseded ' }),
      ev({ type: 'llm_chunk', content: 'mid-stream' }),
      ev({ type: 'step', content: { role: 'assistant', content: 'final canonical answer' } }),
      ev({ type: 'done' }),
    ])
    expect(acc.outcome().text).toBe('final canonical answer')
  })

  it('without an assistant step, text is the chunk concatenation', () => {
    const acc = runThrough([
      ev({ type: 'llm_chunk', content: 'hello ' }),
      ev({ type: 'llm_chunk', content: 'world' }),
      ev({ type: 'done' }),
    ])
    expect(acc.outcome().text).toBe('hello world')
  })

  it('child-agent chunks and steps (execution_context_id set) never leak into the primary answer', () => {
    const acc = runThrough([
      ev({ type: 'llm_chunk', content: 'expert chatter', execution_context_id: 'ec-1' }),
      ev({ type: 'step', content: { role: 'assistant', content: 'expert answer' }, execution_context_id: 'ec-1' }),
      ev({ type: 'llm_chunk', content: 'primary answer' }),
      ev({ type: 'done' }),
    ])
    expect(acc.outcome().text).toBe('primary answer')
  })

  it('generated_files come from the assistant step; a later step with files updates them', () => {
    const acc = runThrough([
      ev({ type: 'step', content: { role: 'assistant', content: 'made a plot', generated_files: ['a.png'] } }),
      ev({
        type: 'step',
        content: { role: 'assistant', content: 'final', generated_files: ['a.png', 'results/umap.png'] },
      }),
      ev({ type: 'done' }),
    ])
    expect(acc.outcome().generatedFiles).toEqual(['a.png', 'results/umap.png'])
  })

  it('usage events sum across model iterations', () => {
    const acc = runThrough([
      ev({ type: 'usage', content: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }),
      ev({ type: 'usage', content: { input_tokens: 200, output_tokens: 20, total_tokens: 220 } }),
      ev({ type: 'done' }),
    ])
    expect(acc.outcome().usage).toEqual({ input_tokens: 300, output_tokens: 30, total_tokens: 330 })
  })

  it('progress keeps the LATEST snapshot per bar and drops finished bars', () => {
    const acc = runThrough([
      ev({ type: 'progress', bar_id: 'b1', label: 'UMAP', current: 1, percent: 10, elapsed: 1, unit: 'it', done: false }),
      ev({ type: 'progress', bar_id: 'b1', label: 'UMAP', current: 5, percent: 50, elapsed: 5, unit: 'it', done: false }),
      ev({ type: 'progress', bar_id: 'b2', label: 'PCA', current: 2, percent: 20, elapsed: 1, unit: 'it', done: false }),
    ])
    expect(acc.outcome().progressLabel).toBe('UMAP 50% · PCA 20%')

    acc.consume(ev({ type: 'progress', bar_id: 'b1', label: 'UMAP', current: 10, percent: 100, elapsed: 9, unit: 'it', done: true }))
    expect(acc.outcome().progressLabel).toBe('PCA 20%')
  })

  it('tool_started builds the audit log in order, primary turn only', () => {
    const acc = runThrough([
      ev({ type: 'tool_started', tool_name: 'run_python_code', started_at: 1 }),
      ev({ type: 'tool_started', tool_name: 'child_tool', started_at: 2, execution_context_id: 'ec-1' }),
      ev({ type: 'tool_started', tool_name: 'registry_lookup', started_at: 3 }),
    ])
    expect(acc.outcome().toolLog).toEqual(['run_python_code', 'registry_lookup'])
  })

  it('done with an abnormal reason surfaces as error; natural done does not', () => {
    const abnormal = runThrough([ev({ type: 'done', reason: 'error' })]).outcome()
    expect(abnormal.error).toMatch(/abnormally/)
    expect(abnormal.finished).toBe(true)

    const natural = runThrough([ev({ type: 'done' })]).outcome()
    expect(natural.error).toBeUndefined()
    expect(natural.doneReason).toBeUndefined()

    const cancelled = runThrough([ev({ type: 'done', reason: 'cancelled' })]).outcome()
    expect(cancelled.error).toBe('turn cancelled')
  })

  it('an error event wins over the done-reason synthesis', () => {
    const acc = runThrough([ev({ type: 'error', content: 'kernel exploded' }), ev({ type: 'done', reason: 'error' })])
    expect(acc.outcome().error).toBe('kernel exploded')
  })
})

describe('formatProgress', () => {
  it('renders percent + eta when known, count + unit when indeterminate', () => {
    const withPct = { type: 'progress', bar_id: 'b', label: 'UMAP', current: 5, percent: 42.4, eta: 12.6, elapsed: 3, unit: 'it', done: false }
    expect(formatProgress(withPct as unknown as ProgressEvent)).toBe('UMAP 42% (13s left)')
    const bare = { type: 'progress', bar_id: 'b', label: 'reading', current: 1234, elapsed: 3, unit: 'cells', done: false }
    expect(formatProgress(bare as unknown as ProgressEvent)).toBe('reading 1234 cells')
  })
})
