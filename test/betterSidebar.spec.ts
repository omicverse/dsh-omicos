/**
 * The optional-integration contract with the third-party
 * `dsh-better-sidebar` plugin. The divergence that matters: our client
 * half must be FULLY functional when that plugin is absent — the sidebar
 * README's documented pattern (`export const inject = ['betterSidebar']`)
 * would have made it a hard dependency and hidden the OmicOS tabs from
 * every user without the sidebar installed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerBetterSidebarTab } from '../src/client/betterSidebar.js'
import { absolutize } from '../src/client/paths.js'

interface InjectCall {
  names: string[]
  callback: (sub: Context) => void
}

/** A cordis-shaped stub that records `ctx.inject` and never fires it (service absent). */
function stubCtx(service?: unknown): { ctx: Context; injects: InjectCall[]; effects: string[] } {
  const injects: InjectCall[] = []
  const effects: string[] = []
  const sub = {
    betterSidebar: service,
    effect: (execute: () => unknown, label?: string) => {
      effects.push(label ?? '')
      execute()
      return () => {}
    },
  }
  const ctx = {
    inject: (names: string[], callback: (s: Context) => void) => {
      injects.push({ names, callback })
    },
    ...sub,
  } as unknown as Context
  return { ctx, injects, effects }
}

describe('registerBetterSidebarTab', () => {
  it('asks for the service through the DEFERRED inject form (never a hard dependency)', () => {
    const { ctx, injects } = stubCtx()
    registerBetterSidebarTab(ctx)
    expect(injects).toHaveLength(1)
    expect(injects[0]!.names).toEqual(['betterSidebar'])
  })

  it('registers nothing when the sidebar plugin is absent — the callback simply never fires', () => {
    const { ctx, injects, effects } = stubCtx()
    registerBetterSidebarTab(ctx)
    // cordis holds the callback until the service appears; nothing ran.
    expect(effects).toEqual([])
    expect(injects[0]!.callback).toBeTypeOf('function')
  })

  it('registers a single-instance tab through the real descriptor shape once the service appears', () => {
    const registerTab = vi.fn().mockReturnValue(() => {})
    const { ctx, injects } = stubCtx({ registerTab })
    registerBetterSidebarTab(ctx)

    // Simulate cordis resolving the service: it hands us the injected scope.
    const scope = stubCtx({ registerTab })
    injects[0]!.callback(scope.ctx)

    expect(registerTab).toHaveBeenCalledTimes(1)
    const descriptor = registerTab.mock.calls[0]![0] as {
      id: string
      title: () => string
      single?: boolean
      component: (props: unknown) => unknown
    }
    expect(descriptor.id).toBe('omicos:files')
    expect(descriptor.title()).toContain('OmicOS')
    // Their `single` sugar: reopening focuses the existing tab (no duplicates).
    expect(descriptor.single).toBe(true)
    // The registration rides an effect so plugin/HMR unload removes the tab.
    expect(scope.effects).toEqual(['omicos: better-sidebar tab'])
  })

  it('the tab body forwards the sidebar scope and pauses polling while hidden', () => {
    const registerTab = vi.fn().mockReturnValue(() => {})
    const { ctx, injects } = stubCtx({ registerTab })
    registerBetterSidebarTab(ctx)
    injects[0]!.callback(stubCtx({ registerTab }).ctx)
    const { component } = registerTab.mock.calls[0]![0] as {
      component: (props: unknown) => { props: { sessionId: string; paused: boolean } }
    }

    const visible = component({ scope: { sessionId: 'session-abc' }, visible: true })
    expect(visible.props).toMatchObject({ sessionId: 'session-abc', paused: false })

    const hidden = component({ scope: { sessionId: 'session-abc' }, visible: false })
    expect(hidden.props.paused).toBe(true)
  })
})

describe('absolutize (chat file chips)', () => {
  it('makes workspace-relative paths absolute so the sidebar file pipeline accepts them', () => {
    // Verified live: dsh-better-sidebar's /sidebar/file answers 400
    // "is not an absolute path" for a relative path and 200 for the same
    // file absolute. dsh's own openFile accepts either.
    expect(absolutize('outputs/figures/a.png', '/ws')).toBe('/ws/outputs/figures/a.png')
    expect(absolutize('outputs/a.png', '/ws/')).toBe('/ws/outputs/a.png')
  })

  it('leaves already-absolute paths and cwd-less calls untouched', () => {
    expect(absolutize('/abs/a.png', '/ws')).toBe('/abs/a.png')
    expect(absolutize('outputs/a.png', undefined)).toBe('outputs/a.png')
    expect(absolutize('outputs/a.png', '')).toBe('outputs/a.png')
  })
})
