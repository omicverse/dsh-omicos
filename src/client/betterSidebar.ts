/**
 * OPTIONAL integration with the third-party `dsh-better-sidebar` plugin
 * (VS Code-style right sidebar): when the user has it installed, OmicOS
 * products get a sidebar tab so figures stay visible BESIDE the running
 * conversation instead of only inside a session-view tab.
 *
 * 🔴 Optional means optional. The sidebar plugin's own README documents
 * `export const inject = ['betterSidebar']`, which is a HARD dependency —
 * our client half would refuse to load (no OmicOS tab, no toolview) for
 * every user who does not have the sidebar installed. We use the runtime
 * deferred form instead: `ctx.inject([...], cb)` fires the callback only
 * once the service exists and unwinds our registration with the injected
 * scope, so "not installed" is simply "callback never fires".
 *
 * The descriptor shape is checked against the REAL published types
 * (dsh-better-sidebar@0.12.2 `lib/types/client/service.d.ts`), which is a
 * devDependency: type-only, so nothing enters the bundle — verified by
 * `test/clientBundle.spec.ts`.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TabComponentProps, TabDescriptor } from 'dsh-better-sidebar/client/service'
import { FilesTab } from './FilesTab.js'

/** Sidebar tab ids are namespaced by convention (`'<plugin>:<tab>'`, e.g. their `'explorer'` / docs' `'my-plugin:db'`). */
const TAB_ID = 'omicos:files'

/** Structural face of the optional service — only what we call. */
interface BetterSidebarLike {
  registerTab(descriptor: TabDescriptor): () => void
}

/** The tab body: our files panel, driven by the sidebar's own session scope. */
function OmicosSidebarTab({ scope, visible }: TabComponentProps): ReturnType<typeof createElement> {
  // `visible` is false while another tab is active or the panel is closed —
  // pass it through so the list polling pauses instead of burning requests
  // behind a hidden panel.
  return createElement(FilesTab, { sessionId: scope.sessionId, paused: !visible })
}

/**
 * Register the sidebar tab IF the sidebar plugin is present. Safe to call
 * unconditionally; returns nothing (the injected scope owns teardown).
 */
export function registerBetterSidebarTab(ctx: Context): void {
  // 'betterSidebar' is not in OUR Context service map (it is a third-party
  // plugin's service, and we deliberately do not merge its module
  // augmentation — that would type it as always-present). The cast is the
  // narrow price of keeping the dependency optional.
  const injectable = ctx as unknown as {
    inject(names: string[], callback: (sub: Context) => void): void
  }
  injectable.inject(['betterSidebar'], (sub) => {
    const service = (sub as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar
    if (service === undefined) return
    sub.effect(
      () =>
        service.registerTab({
          id: TAB_ID,
          title: () => 'OmicOS 产物',
          // Single-instance: opening from the + menu focuses the existing
          // tab rather than stacking duplicates (their `single` sugar).
          single: true,
          order: 60,
          component: OmicosSidebarTab,
        }),
      'omicos: better-sidebar tab',
    )
  })
}
