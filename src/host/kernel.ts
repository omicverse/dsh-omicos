/**
 * Lazy omicos-core lifecycle for the dsh host (DSH-PLUGIN.md §7): nothing
 * is spawned at plugin load — the first tool call / login command asks for
 * `handle()`, which discovers-or-spawns via `@omicverse/omicos-launcher`
 * (single-flight: concurrent callers share one in-flight ensure).
 *
 * dsh-free on purpose: the plugin's `apply()` wires `dispose()` into ONE
 * `ctx.effect` so teardown is ordered there (D1 — parallel async disposers
 * would race an SSE close against the kernel SIGTERM).
 *
 * F13 discipline is inherited from the launcher: `stop()` on an ATTACHED
 * handle is a no-op — we only ever SIGTERM a core this plugin itself
 * spawned.
 */
import type { CoreHandle, EnsureCoreOptions } from '@omicverse/omicos-launcher'
import { ensureCore } from '@omicverse/omicos-launcher'
import { installedCoreCommand } from './coreCommand.js'

export interface KernelManagerOptions {
  /** Workspace directory the core binds to (DESIGN.md §5 discovery key). */
  workspace: string
  /** `false` -> attach-only; first use throws `CoreNotRunningError` when nothing is discoverable. */
  autoStart?: boolean
  /** `npm_config_registry` override for the `npx @omicverse/omicos` spawn (mainland-mirror knob). */
  npmRegistry?: string
  /** Cloud auth/account base URL, forwarded as the spawned core's `--upstream-base-url`. */
  upstreamBaseUrl?: string
  /** Test seam. */
  ensureImpl?: typeof ensureCore
  /** Test seam for the installed-core lookup. */
  coreCommandImpl?: typeof installedCoreCommand
}

export class KernelManager {
  private inflight: Promise<CoreHandle> | undefined
  private current: CoreHandle | undefined
  private disposed = false

  constructor(private readonly opts: KernelManagerOptions) {}

  /** The core's base URL if a handle already exists (no side effects). */
  get baseUrl(): string | undefined {
    return this.current?.baseUrl
  }

  get isSpawned(): boolean {
    return this.current?.spawned ?? false
  }

  /**
   * Discover-or-spawn, memoized. A handle that stops answering is the
   * caller's problem to detect (HTTP errors) — call `reset()` to force
   * re-discovery on the next `handle()`.
   */
  async handle(): Promise<CoreHandle> {
    if (this.disposed) throw new Error('KernelManager is disposed')
    if (this.current) return this.current
    if (!this.inflight) {
      const ensure = this.opts.ensureImpl ?? ensureCore
      // Prefer the core that came in with this package over `npx`; undefined
      // (unresolvable dependency) leaves the launcher's npx default in place.
      const installed = (this.opts.coreCommandImpl ?? installedCoreCommand)(
        this.opts.workspace,
        this.opts.upstreamBaseUrl,
      )
      const ensureOpts: EnsureCoreOptions = {
        autoStart: this.opts.autoStart,
        npmRegistry: this.opts.npmRegistry,
        upstreamBaseUrl: this.opts.upstreamBaseUrl,
        ...(installed === undefined ? {} : { command: installed }),
      }
      this.inflight = ensure(this.opts.workspace, ensureOpts).then(
        (h) => {
          this.current = h
          this.inflight = undefined
          // Lost the race with dispose(): honor it now (only kills a core WE spawned).
          if (this.disposed) h.stop()
          return h
        },
        (err) => {
          this.inflight = undefined
          throw err
        },
      )
    }
    return this.inflight
  }

  /** Drop the memoized handle so the next `handle()` re-discovers. Does NOT stop anything. */
  reset(): void {
    this.current = undefined
  }

  /**
   * Stop a SELF-SPAWNED core and forget the handle, but keep this manager
   * usable — the next `handle()` re-discovers/re-spawns. (An attached
   * core's `stop` is a launcher-level no-op, F13.) This is the
   * user-facing "stop kernel" semantic; `dispose()` is plugin teardown.
   */
  stopSpawned(): void {
    this.current?.stop()
    this.current = undefined
  }

  /** Stop a self-spawned core (attached cores are untouched — F13) and refuse further use. */
  dispose(): void {
    this.disposed = true
    this.current?.stop()
    this.current = undefined
  }
}

/**
 * Deterministic dsh-session -> omicos-conversation id (DSH-PLUGIN.md §3
 * Mode A: continuity without a mapping file). Sanitized because core's
 * storage validates reserved ids as path components.
 */
export function deriveOmicosSessionId(dshSessionId: string): string {
  const safe = dshSessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96)
  return `dsh-${safe}`
}
