/**
 * Live-activity mirroring (v0.2): map the omicos SSE stream of ONE turn
 * into a compact sequence of activity snapshots suitable for appending to
 * dsh's session log as `omicos/activity` events (ignorable UI telemetry —
 * they never enter the model context) and rendering as a live "what is
 * the nested omicos agent doing" card.
 *
 * dsh-free by design (same rule as bridge.ts): this module knows nothing
 * about SessionEvents — it turns raw StreamEvents into plain JSON
 * snapshots; `tools.ts` owns the actual `session.append` calls.
 *
 * Snapshot (not delta) semantics, deliberately: dsh conversation-node
 * assemblers can miss a `start` on reattach (D8), and the renderer may
 * coalesce under `animation-frame` — every emitted payload must therefore
 * be independently renderable. To bound append volume on chatty streams
 * (`tool_output_chunk` fires per stdout write), emissions are throttled:
 * structural changes (phase/tool/exec-line transitions) emit immediately,
 * pure-text growth (stdout tail, progress ticks) emits at most once per
 * `throttleMs`.
 */
import type { StreamEvent } from '@omicverse/omicos-protocol'
import { formatProgress } from './bridge.js'

/** One independently-renderable snapshot of the nested omicos turn. */
export interface ActivitySnapshot {
  /** Monotonic per-turn sequence (stable business id material for the node). */
  n: number
  /** Coarse phase for the card's headline. */
  phase: 'thinking' | 'tool' | 'done'
  /** Tool currently executing (phase `tool`). */
  tool?: string
  /** 1-based statement range currently executing inside the running cell (exec_line). */
  execLines?: { start: number; end: number }
  /** Tail of the running tool's live stdout (last ~`stdoutTailChars`). */
  stdoutTail?: string
  /** Live tqdm bars, one line per active bar (full-value snapshots). */
  progress?: string[]
  /** Set once on the final snapshot. */
  outcome?: 'ok' | 'error' | 'cancelled'
  error?: string
}

export interface ActivityMirrorOptions {
  /** Minimum ms between non-structural emissions. Default 300. */
  throttleMs?: number
  /** How much stdout tail to keep. Default 400 chars. */
  stdoutTailChars?: number
  /** Clock seam for tests. */
  now?: () => number
}

/**
 * Feed every StreamEvent of one turn; `emit` fires with snapshots ready
 * to be appended. Call `finish()` after the event loop ends to flush the
 * terminal snapshot (also fired on a `done` event).
 */
export class ActivityMirror {
  private readonly throttleMs: number
  private readonly tailChars: number
  private readonly now: () => number

  private seq = 0
  private phase: ActivitySnapshot['phase'] = 'thinking'
  private tool: string | undefined
  private execLines: { start: number; end: number } | undefined
  private stdout = ''
  private readonly bars = new Map<string, string>()
  private lastEmit = 0
  private dirty = false
  private finished = false

  constructor(
    private readonly emit: (snapshot: ActivitySnapshot) => void,
    opts: ActivityMirrorOptions = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 300
    this.tailChars = opts.stdoutTailChars ?? 400
    this.now = opts.now ?? Date.now
  }

  consume(event: StreamEvent): void {
    if (this.finished) return
    switch (event.type) {
      case 'tool_started': {
        if (event.execution_context_id) return
        this.phase = 'tool'
        this.tool = event.tool_name
        this.execLines = undefined
        this.stdout = ''
        this.emitNow()
        return
      }
      case 'step': {
        // A persisted assistant/tool message means the current tool phase
        // ended and the model is deciding what to do next.
        if (event.execution_context_id) return
        if (this.phase !== 'thinking') {
          this.phase = 'thinking'
          this.tool = undefined
          this.execLines = undefined
          this.emitNow()
        }
        return
      }
      case 'exec_line': {
        const next = event.done ? undefined : { start: event.line_start, end: event.line_end }
        const changed = next?.start !== this.execLines?.start || next?.end !== this.execLines?.end
        this.execLines = next
        if (changed) this.emitNow()
        return
      }
      case 'tool_output_chunk': {
        this.stdout = (this.stdout + event.chunk).slice(-this.tailChars)
        this.emitThrottled()
        return
      }
      case 'progress': {
        if (event.done) this.bars.delete(event.bar_id)
        else this.bars.set(event.bar_id, formatProgress(event))
        this.emitThrottled()
        return
      }
      case 'error': {
        this.finish('error', event.content)
        return
      }
      case 'done': {
        this.finish(event.reason === 'cancelled' ? 'cancelled' : event.reason ? 'error' : 'ok')
        return
      }
      default:
        return
    }
  }

  /** Idempotent terminal flush. */
  finish(outcome: 'ok' | 'error' | 'cancelled' = 'ok', error?: string): void {
    if (this.finished) return
    this.finished = true
    this.phase = 'done'
    this.tool = undefined
    this.execLines = undefined
    this.emit(this.snapshot({ outcome, error }))
  }

  private snapshot(extra: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
    this.seq += 1
    const snap: ActivitySnapshot = { n: this.seq, phase: this.phase, ...extra }
    if (this.tool !== undefined) snap.tool = this.tool
    if (this.execLines !== undefined) snap.execLines = this.execLines
    if (this.stdout !== '') snap.stdoutTail = this.stdout
    if (this.bars.size > 0) snap.progress = [...this.bars.values()]
    return snap
  }

  private emitNow(): void {
    this.lastEmit = this.now()
    this.dirty = false
    this.emit(this.snapshot())
  }

  private emitThrottled(): void {
    const t = this.now()
    if (t - this.lastEmit >= this.throttleMs) {
      this.lastEmit = t
      this.dirty = false
      this.emit(this.snapshot())
    } else {
      this.dirty = true
    }
  }

  /** True when a throttled change is pending (callers may flush before long idles). */
  get hasPending(): boolean {
    return this.dirty && !this.finished
  }

  /** Flush a pending throttled change immediately (no-op when clean). */
  flushPending(): void {
    if (this.hasPending) this.emitNow()
  }
}
