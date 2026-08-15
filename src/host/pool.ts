/**
 * Per-workspace kernel/runner pool. Found the hard way (first real user
 * run, 2026-08-15): dsh is multi-workspace — the AGENT's workspace is
 * `session.header.cwd`, and the plugin's original "one kernel bound to
 * the host process cwd" default spawned a second core in whatever
 * directory the dsh host happened to be launched from, instead of
 * attaching to the core already serving the workspace the user selected
 * in the dsh UI.
 *
 * One entry per resolved workspace directory; each entry owns one
 * `KernelManager` (attach-or-spawn per DESIGN.md §5) and one
 * `OmicosRunner` (conversation continuity + transport reuse).
 */
import { KernelManager, type KernelManagerOptions } from './kernel.js'
import { OmicosRunner } from './runner.js'

export interface PoolEntry {
  workspace: string
  kernel: KernelManager
  runner: OmicosRunner
}

export type PoolBaseOptions = Omit<KernelManagerOptions, 'workspace'>

export class OmicosPool {
  private readonly byDir = new Map<string, PoolEntry>()

  constructor(private readonly base: PoolBaseOptions) {}

  /** Get-or-create the entry for a workspace directory. */
  entry(workspace: string): PoolEntry {
    let entry = this.byDir.get(workspace)
    if (!entry) {
      const kernel = new KernelManager({ ...this.base, workspace })
      entry = { workspace, kernel, runner: new OmicosRunner(kernel) }
      this.byDir.set(workspace, entry)
    }
    return entry
  }

  /** Entries created so far (status surfaces). */
  list(): PoolEntry[] {
    return [...this.byDir.values()]
  }

  /** Stop every SELF-SPAWNED core, keep the pool usable (user-facing stop). */
  stopSpawned(): number {
    let stopped = 0
    for (const entry of this.byDir.values()) {
      if (entry.kernel.isSpawned) {
        entry.kernel.stopSpawned()
        stopped += 1
      } else {
        entry.kernel.reset()
      }
    }
    return stopped
  }

  /** Plugin teardown: terminal dispose of every manager. */
  dispose(): void {
    for (const entry of this.byDir.values()) entry.kernel.dispose()
    this.byDir.clear()
  }
}
