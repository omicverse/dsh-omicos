/**
 * Pure accumulation of an omicos SSE turn into a Mode A tool outcome
 * (DSH-PLUGIN.md §4 bridge.ts, §5 right-hand column). ZERO dsh imports by
 * design — the anti-corruption boundary: everything here is testable
 * against recorded omicos fixtures and survives dsh churn untouched.
 *
 * Semantics mirror the panel store's reducer (packages/panel/src/
 * transcript/store.ts) for the events Mode A cares about:
 *  - `llm_chunk` appends to the assistant text — PRIMARY turn only
 *    (`execution_context_id` set = child agent/expert chatter, not the
 *    final answer).
 *  - a `step` whose content is a persisted assistant message with text is
 *    AUTHORITATIVE: it replaces the accumulated chunk text (the store
 *    does the same flush-then-overwrite dance), and its
 *    `generated_files` — set only on the FINAL assistant message of a
 *    turn (protocol messages.ts) — is the file list.
 *  - `usage` events are summed across model iterations.
 *  - `progress` keeps only the latest human-readable snapshot per bar
 *    (job-label material; full-value snapshot, never deltas — §5).
 *  - `error` / `done(reason)` decide success.
 */
import type {
  DoneEvent,
  ErrorEvent,
  LlmChunkEvent,
  ProgressEvent,
  StepEvent,
  StreamEvent,
  ToolStartedEvent,
  UsageEventContent,
  UsageEvent,
} from '@omicverse/omicos-protocol'

export interface OmicosTurnOutcome {
  /** Final assistant answer text (primary turn). Empty string when the turn produced none. */
  text: string
  /** Workspace-relative paths of files the turn created/modified (final assistant step's `generated_files`). */
  generatedFiles: string[]
  /** Summed across every `usage` event of the turn; `undefined` when none arrived. */
  usage?: UsageEventContent
  /** Latest progress snapshot per active bar, e.g. `"UMAP  42% (12.3s left)"` — job-label material. */
  progressLabel?: string
  /** One line per top-level tool invocation, in order — audit-trail material for the tool result meta. */
  toolLog: string[]
  /** Set when the turn ended abnormally (`error` event, or `done` with an abnormal reason). */
  error?: string
  /** `done.reason` verbatim (`undefined` = natural completion). */
  doneReason?: string
  /** True once a `done` event has been consumed. */
  finished: boolean
}

function isPrimary(ev: { execution_context_id?: string }): boolean {
  return !ev.execution_context_id
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** Human-readable single-line snapshot of a tqdm `progress` event. */
export function formatProgress(e: ProgressEvent): string {
  const label = e.label || 'working'
  if (typeof e.percent === 'number') {
    const eta = typeof e.eta === 'number' ? ` (${Math.round(e.eta)}s left)` : ''
    return `${label} ${Math.round(e.percent)}%${eta}`
  }
  return `${label} ${e.current}${e.unit ? ` ${e.unit}` : ''}`
}

/**
 * Mutable single-turn accumulator. Feed every `StreamEvent` of one turn
 * (in seq order — the SDK's TurnController already guarantees gap-free
 * ordering across reconnects) and read `outcome()` after `finished`.
 */
export class TurnAccumulator {
  private chunks: string[] = []
  private authoritativeText: string | undefined
  private files: string[] = []
  private usageSum: UsageEventContent | undefined
  private progress = new Map<string, string>()
  private tools: string[] = []
  private errorText: string | undefined
  private reason: string | undefined
  private done = false

  consume(event: StreamEvent): void {
    switch (event.type) {
      case 'llm_chunk': {
        const e = event as LlmChunkEvent
        if (isPrimary(e)) this.chunks.push(e.content)
        return
      }
      case 'step':
        this.consumeStep(event as StepEvent)
        return
      case 'tool_started': {
        const e = event as ToolStartedEvent
        if (isPrimary(e)) this.tools.push(e.tool_name)
        return
      }
      case 'usage': {
        const c = (event as UsageEvent).content
        this.usageSum = this.usageSum
          ? {
              input_tokens: this.usageSum.input_tokens + c.input_tokens,
              output_tokens: this.usageSum.output_tokens + c.output_tokens,
              total_tokens: this.usageSum.total_tokens + c.total_tokens,
            }
          : { ...c }
        return
      }
      case 'progress': {
        const e = event as ProgressEvent
        if (e.done) this.progress.delete(e.bar_id)
        else this.progress.set(e.bar_id, formatProgress(e))
        return
      }
      case 'error':
        this.errorText = (event as ErrorEvent).content
        return
      case 'done': {
        const e = event as DoneEvent
        this.done = true
        this.reason = e.reason
        if (e.reason && e.reason !== 'cancelled' && !this.errorText) {
          this.errorText = `turn ended abnormally: ${e.reason}`
        } else if (e.reason === 'cancelled' && !this.errorText) {
          this.errorText = 'turn cancelled'
        }
        return
      }
      default:
        return
    }
  }

  private consumeStep(e: StepEvent): void {
    const content = asRecord(e.content)
    if (!content) return
    if (!isPrimary({ execution_context_id: e.execution_context_id ?? (content.execution_context_id as string | undefined) }))
      return
    if (content.role !== 'assistant') return
    const text = typeof content.content === 'string' ? content.content : undefined
    if (text) this.authoritativeText = text
    if (Array.isArray(content.generated_files) && content.generated_files.length > 0) {
      this.files = content.generated_files.map(String)
    }
  }

  outcome(): OmicosTurnOutcome {
    return {
      text: this.authoritativeText ?? this.chunks.join(''),
      generatedFiles: this.files.slice(),
      usage: this.usageSum ? { ...this.usageSum } : undefined,
      progressLabel: this.progress.size > 0 ? [...this.progress.values()].join(' · ') : undefined,
      toolLog: this.tools.slice(),
      error: this.errorText,
      doneReason: this.reason,
      finished: this.done,
    }
  }
}
