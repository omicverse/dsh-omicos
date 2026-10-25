import { useEffect, useRef } from 'react'

const COLLECT = 'omicos:collect-unsaved-editors'
interface Collection {
  within?: Element
  tabId?: string
  sessionId?: string
  editors: string[]
}

/** No draft text leaves its editor or enters browser storage through this guard. */
export function useUnsavedNavigation(dirty: boolean, label: string) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!dirty) return
    const collect = (event: Event) => {
      const root = ref.current
      const detail = (event as CustomEvent<Collection>).detail
      if (!root) return
      if (
        detail.sessionId &&
        root
          .closest('[data-sidebar-right-session]')
          ?.getAttribute('data-sidebar-right-session') !== detail.sessionId
      )
        return
      if (detail.tabId) {
        if (
          root
            .closest('[data-sidebar-right-tab]')
            ?.getAttribute('data-sidebar-right-tab') !== detail.tabId
        )
          return
      } else {
        if (!root.isConnected || !root.getClientRects().length) return
        if (
          detail.within
            ? !detail.within.contains(root)
            : root.closest('[data-rightbar-col]')
        )
          return
      }
      if (!detail.editors.includes(label)) detail.editors.push(label)
    }
    window.addEventListener(COLLECT, collect)
    return () => window.removeEventListener(COLLECT, collect)
  }, [dirty, label])
  return ref
}

export function confirmUnsavedNavigation(
  within?: Element,
  tabId?: string,
  sessionId?: string
): boolean {
  const detail: Collection = { within, tabId, sessionId, editors: [] }
  window.dispatchEvent(new CustomEvent<Collection>(COLLECT, { detail }))
  return (
    !detail.editors.length ||
    window.confirm(
      `有未保存的编辑：${detail.editors.join('、')}。离开将放弃这些修改，是否继续？已提交的任务不会因此取消。`
    )
  )
}

/** Protect pointer navigation and native docked, floating and context-menu close actions. */
export function installNavigationGuard(
  panelLabels: () => string[]
): () => void {
  let menuTarget: { tabId: string; sessionId: string } | undefined
  const sessionOf = (element: Element) =>
    element
      .closest('[data-sidebar-right-session]')
      ?.getAttribute('data-sidebar-right-session') || undefined
  const contextMenu = (event: MouseEvent) => {
    menuTarget = undefined
    if (!(event.target instanceof Element)) return
    const tab = event.target.closest('[data-dockkit-tab]')
    const tabId = tab?.getAttribute('data-dockkit-tab')
    const sessionId = tab && sessionOf(tab)
    if (tabId && sessionId) menuTarget = { tabId, sessionId }
  }
  const guard = (event: MouseEvent) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const target = event.target
    const close = target.closest(
      '[data-dockkit-tab-close], [data-dockkit-float-close], [data-dockkit-menu-close]'
    )
    if (close) {
      const floating = close.closest('[data-dockkit-float]')
      const fromMenu = close.matches('[data-dockkit-menu-close]')
      const tabId = fromMenu
        ? menuTarget?.tabId
        : close.getAttribute('data-dockkit-tab-close') ||
          floating
            ?.querySelector('[data-sidebar-right-tab]')
            ?.getAttribute('data-sidebar-right-tab')
      const sessionId = fromMenu ? menuTarget?.sessionId : sessionOf(close)
      if (
        tabId &&
        sessionId &&
        !confirmUnsavedNavigation(undefined, tabId, sessionId)
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (target.closest('[role="dialog"], [data-rightbar-col]')) return
    const control = target.closest(
      'button, [role="tab"], [data-row-key^="session:"]'
    )
    if (
      !control ||
      control.getAttribute('aria-current') === 'page' ||
      control.getAttribute('aria-selected') === 'true'
    )
      return
    const name = control.getAttribute('aria-label') || ''
    const navigation =
      control.closest('.omicos-science-tabs') ||
      control.getAttribute('role') === 'tab' ||
      control.matches('[data-row-key^="session:"]') ||
      /^(New Session|新会话)$/.test(name) ||
      panelLabels().includes(name) ||
      (control.closest('.omicos-rail') && name !== '切换深浅外观')
    if (navigation && !confirmUnsavedNavigation()) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  document.addEventListener('contextmenu', contextMenu, true)
  document.addEventListener('click', guard, true)
  return () => {
    document.removeEventListener('contextmenu', contextMenu, true)
    document.removeEventListener('click', guard, true)
    menuTarget = undefined
  }
}
