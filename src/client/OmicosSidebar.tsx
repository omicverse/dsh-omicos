import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type Filter = 'all' | 'running' | 'unread'
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'unread', label: '未读' }
]

/** The conversation list header: title and the all / running / unread filter strip. */
export function OmicosSidebarHeader({
  useSessions,
  useSessionStatus
}: PropsRuntime<'shell.overlay'>): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const byId = useSessions((state) => state.byId)
  const statuses = useSessionStatus((snapshot) => snapshot)
  useEffect(() => {
    let mount: HTMLElement | null = null
    const attach = (): void => {
      const region = document.querySelector<HTMLElement>('[class*="_regionArea"]')
      if (!region || region.querySelector('[data-omicos-sidebar-header]')) return
      mount = document.createElement('div')
      mount.dataset.omicosSidebarHeader = ''
      region.prepend(mount)
      setHost(mount)
    }
    attach()
    const observer = new MutationObserver(() => {
      if (!mount?.isConnected) {
        mount = null
        setHost(null)
        attach()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mount?.remove()
      setHost(null)
    }
  }, [])
  const groups = useMemo(() => {
    const running: string[] = []
    const unread: string[] = []
    const all = Object.values(byId)
    for (const session of all) {
      const status = statuses.get(session.id)
      if (status?.running ?? session.running) running.push(session.id)
      if (status?.completionUnread) unread.push(session.id)
    }
    return { all: all.map((session) => session.id), running, unread }
  }, [byId, statuses])
  const hidden = useMemo(() => {
    if (filter === 'all') return []
    const keep = new Set(groups[filter])
    return groups.all.filter((id) => !keep.has(id))
  }, [filter, groups])
  const rules = hidden
    .map((id) => `[data-row-key="session:${CSS.escape(id)}"]`)
    .join(',')
  if (!host) return null
  return createPortal(
    <header className="omicos-conversations">
      <div className="omicos-conversations-title">
        <span>对话</span>
      </div>
      <div className="omicos-conversations-tabs" role="tablist" aria-label="对话筛选">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            {item.id !== 'all' && groups[item.id].length ? (
              <i>{groups[item.id].length}</i>
            ) : null}
          </button>
        ))}
      </div>
      {rules ? <style>{`${rules}{display:none !important}`}</style> : null}
    </header>,
    host
  )
}
