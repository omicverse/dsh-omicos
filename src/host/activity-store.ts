/**
 * In-memory live-activity feed, keyed by dsh tool callId (v0.2 activity
 * visualization). The browser's toolview polls `/omicos/activity/<callId>`
 * while its call runs.
 *
 * 🔴 Why not custom SessionEvents (the design's original D5 plan): dsh's
 * persistence READ path refuses any log containing an event type outside
 * the generated `KNOWN_SESSION_EVENT_TYPES` whitelist unless the event
 * carries `ignorable: true` — and `Session.append()` exposes NO way to set
 * that marker ("a registration surface for [out-of-repo events] is
 * deferred until such a consumer exists", known-event-types.ts). Appending
 * `omicos/activity` would work live and then make the whole session
 * UNLOADABLE after a restart (SessionFormatUnsupportedError,
 * coordinator.ts:1063). So live activity stays OUT of dsh's ledger: this
 * ephemeral store + same-origin polling. Replay/debug material is covered
 * separately by the bounded trace in the tool result.
 *
 * dsh-free; bounded: entries are swept `ttlMs` after finish (or after
 * last publish for runs that never finish cleanly), capped at `maxEntries`
 * (oldest evicted first).
 */
import type { ActivitySnapshot } from './activity.js'

export interface ActivityFeed {
  /** Latest snapshot (full state — snapshots are self-contained by design). */
  snapshot?: ActivitySnapshot
  /** False once the turn ended (terminal snapshot flushed). */
  running: boolean
  /** Last publish/finish wall time (sweep anchor). */
  updatedAt: number
}

export class ActivityStore {
  private readonly feeds = new Map<string, ActivityFeed>()

  constructor(
    private readonly opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)()
  }

  publish(callId: string, snapshot: ActivitySnapshot): void {
    const feed = this.feeds.get(callId)
    if (feed) {
      feed.snapshot = snapshot
      feed.running = snapshot.phase !== 'done'
      feed.updatedAt = this.now
    } else {
      this.feeds.set(callId, { snapshot, running: snapshot.phase !== 'done', updatedAt: this.now })
    }
    // Sweep AFTER insert so the cap holds at every exit, not one publish late.
    this.sweep()
  }

  /** Mark a run over even when no terminal snapshot arrived (thrown turn). */
  finish(callId: string): void {
    const feed = this.feeds.get(callId)
    if (feed) {
      feed.running = false
      feed.updatedAt = this.now
    }
  }

  get(callId: string): ActivityFeed | undefined {
    return this.feeds.get(callId)
  }

  private sweep(): void {
    const ttl = this.opts.ttlMs ?? 10 * 60 * 1000
    const cap = this.opts.maxEntries ?? 200
    const cutoff = this.now - ttl
    for (const [id, feed] of this.feeds) {
      if (feed.updatedAt < cutoff) this.feeds.delete(id)
    }
    while (this.feeds.size > cap) {
      let oldest: string | undefined
      let oldestAt = Infinity
      for (const [id, feed] of this.feeds) {
        if (feed.updatedAt < oldestAt) {
          oldestAt = feed.updatedAt
          oldest = id
        }
      }
      if (oldest === undefined) break
      this.feeds.delete(oldest)
    }
  }
}
