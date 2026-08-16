/**
 * dsh-free orchestration for Mode A (DSH-PLUGIN.md §3): one omicos TURN
 * per dsh tool call, on a conversation deterministically derived from the
 * dsh session id — context accumulates core-side across calls, no ghost
 * one-shot sessions.
 *
 * `tools.ts`/`jobs.ts` are thin dsh-facing wrappers over this class so
 * everything that can go wrong (conversation reservation, 409 steering,
 * SSE accumulation) is unit-testable against `mockCore` without a dsh
 * host.
 */
import type { ChatConfig, PermissionMode, StreamEvent } from '@omicverse/omicos-protocol'
import {
  ConversationsClient,
  HttpCoreTransport,
  OmicosHttpError,
  TurnController,
} from '@omicverse/omicos-client'
import type { KernelManager } from './kernel.js'
import { deriveOmicosSessionId } from './kernel.js'
import { TurnAccumulator, type OmicosTurnOutcome } from './bridge.js'

export interface RunTurnOptions {
  /** Live progress snapshots (job-label material, §5) — called with the latest combined label. */
  onProgress?: (label: string) => void
  /**
   * Raw live tap: every StreamEvent of the turn, in seq order, before
   * accumulation (v0.2 activity mirroring — `tools.ts` feeds these to an
   * `ActivityMirror` and appends the snapshots to dsh's session log).
   * Exceptions are swallowed: a broken observer must not kill the turn.
   */
  onEvent?: (event: StreamEvent) => void
  /**
   * Cancellation propagation (found the hard way: a dsh-side abort used
   * to leave the omicos turn running as an orphan). On abort, the active
   * turn is cancelled CORE-SIDE (`POST chat/cancel`) and this call
   * resolves with the partial outcome (`doneReason: "cancelled"`) once
   * core confirms — or rejects if the abort raced send() itself.
   */
  signal?: AbortSignal
  /** v0.1 default `"full"`: tools run inside core unprompted — a blocked approval would deadlock the single-shot tool result (§3 Mode A). */
  permissionMode?: PermissionMode | string
  config?: ChatConfig
}

export class OmicosRunner {
  private readonly reserved = new Set<string>()
  private readonly controllers = new Map<string, TurnController>()
  private transport: HttpCoreTransport | undefined
  private transportBaseUrl: string | undefined

  constructor(private readonly kernel: KernelManager) {}

  /** Kernel-lazy transport (recreated if the core moved ports after a `reset()`). */
  private async getTransport(): Promise<HttpCoreTransport> {
    const handle = await this.kernel.handle()
    if (!this.transport || this.transportBaseUrl !== handle.baseUrl) {
      this.transport = new HttpCoreTransport(handle.baseUrl)
      this.transportBaseUrl = handle.baseUrl
      this.controllers.clear()
    }
    return this.transport
  }

  /**
   * Reserve the derived conversation id on core, once per process
   * lifetime. `CreateConversationRequest.session_id` is the caller-
   * reserved-id path (protocol conversations.ts:79-87); a second create
   * for an id that already exists is treated as benign — any failure here
   * only matters if the subsequent chat POST also fails.
   */
  private async ensureConversation(omicosSessionId: string, title: string): Promise<void> {
    if (this.reserved.has(omicosSessionId)) return
    const transport = await this.getTransport()
    const convs = new ConversationsClient(transport)
    try {
      await convs.create({ session_id: omicosSessionId, title })
    } catch (err) {
      // Conflict/validation on an id that already exists from a previous
      // dsh host run — the conversation is there, which is all we need.
      if (!(err instanceof OmicosHttpError)) throw err
    }
    this.reserved.add(omicosSessionId)
  }

  /**
   * Run ONE omicos turn on the dsh session's conversation and accumulate
   * it into an `OmicosTurnOutcome`. Busy conversation (409) steers the
   * message in as guidance instead of failing (§5 "POST 409" row).
   */
  async runTurn(dshSessionId: string, message: string, opts: RunTurnOptions = {}): Promise<OmicosTurnOutcome> {
    const sid = deriveOmicosSessionId(dshSessionId)
    await this.ensureConversation(sid, `dsh ${dshSessionId}`)
    const transport = await this.getTransport()

    let controller = this.controllers.get(sid)
    if (!controller) {
      controller = new TurnController(transport, sid)
      this.controllers.set(sid, controller)
    }

    const config: ChatConfig = {
      ...opts.config,
      permission_mode: opts.permissionMode ?? opts.config?.permission_mode ?? 'full',
    }

    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await controller.send(message, config, { steerOnBusy: true })

    const onAbort = (): void => {
      // Core-side cancel; the stream then delivers done(reason:"cancelled")
      // which ends the loop below with a coherent partial outcome.
      void controller.cancel().catch(() => {})
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const acc = new TurnAccumulator()
      for await (const event of controller.events()) {
        if (event.type === 'attach_gap') break
        acc.consume(event as Parameters<TurnAccumulator['consume']>[0])
        if (opts.onEvent) {
          try {
            opts.onEvent(event as StreamEvent)
          } catch {
            // observer errors must not kill the turn
          }
        }
        if (event.type === 'progress' && opts.onProgress) {
          const label = acc.outcome().progressLabel
          if (label) opts.onProgress(label)
        }
        if (event.type === 'done') break
      }
      return acc.outcome()
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Aggregate `generated_files` across the conversation's persisted
   * assistant messages (they are set only on each turn's FINAL assistant
   * message — protocol messages.ts), newest last, deduped.
   */
  async listGeneratedFiles(dshSessionId: string): Promise<string[]> {
    const sid = deriveOmicosSessionId(dshSessionId)
    const transport = await this.getTransport()
    const convs = new ConversationsClient(transport)
    let detail
    try {
      detail = await convs.get(sid)
    } catch (err) {
      if (err instanceof OmicosHttpError && err.status === 404) return []
      throw err
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const message of detail.history ?? []) {
      for (const f of message.generated_files ?? []) {
        if (!seen.has(f)) {
          seen.add(f)
          out.push(f)
        }
      }
    }
    return out
  }

  /**
   * The MOST RECENT non-empty `generated_files` of the conversation.
   * Fallback for a turn whose own diff came back empty — found live: an
   * orphan-completed prior turn already recorded the files, so the retry
   * turn's before/after diff saw nothing new even though the results are
   * exactly what the user asked for.
   */
  async lastGeneratedFiles(dshSessionId: string): Promise<string[]> {
    const sid = deriveOmicosSessionId(dshSessionId)
    const transport = await this.getTransport()
    const convs = new ConversationsClient(transport)
    let detail
    try {
      detail = await convs.get(sid)
    } catch {
      return []
    }
    for (let i = (detail.history ?? []).length - 1; i >= 0; i -= 1) {
      const files = detail.history[i]?.generated_files
      if (Array.isArray(files) && files.length > 0) return files.map(String)
    }
    return []
  }

  /**
   * Like [`listGeneratedFiles`] but distinguishes "conversation does not
   * exist on this kernel" (`undefined`) from "exists, no files yet" (`[]`)
   * — the files tab probes every pool entry with this to find which
   * kernel owns a dsh session's conversation.
   */
  async filesIfExists(dshSessionId: string): Promise<string[] | undefined> {
    const sid = deriveOmicosSessionId(dshSessionId)
    const transport = await this.getTransport()
    const convs = new ConversationsClient(transport)
    let detail
    try {
      detail = await convs.get(sid)
    } catch (err) {
      if (err instanceof OmicosHttpError && err.status === 404) return undefined
      throw err
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const message of detail.history ?? []) {
      for (const f of message.generated_files ?? []) {
        if (!seen.has(f)) {
          seen.add(f)
          out.push(f)
        }
      }
    }
    return out
  }

  /** Cancel the session's active turn, if any (used by job stop, §5). */
  async cancel(dshSessionId: string): Promise<void> {
    const sid = deriveOmicosSessionId(dshSessionId)
    const controller = this.controllers.get(sid)
    if (controller) await controller.cancel()
  }
}
