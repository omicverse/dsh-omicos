/**
 * The「OmicOS 产物」sidebar panel: the files THIS dsh session's omicos
 * analyses produced, in one list.
 *
 * Deliberately NOT a previewer. We used to render images/PDF/text
 * ourselves in a session-view tab; that duplicated what
 * `dsh-better-sidebar` already does far better (its own image/PDF/markdown/
 * code viewers, editing, download). This panel contributes the one thing
 * the sidebar's Explorer cannot: a per-session, curated product list — and
 * delegates opening to the host's own `onOpenFile`, so a click lands in
 * the sidebar's viewer.
 *
 * Paths go out ABSOLUTE (`absolutize`): the sidebar's file pipeline calls
 * `requireAbsolute` and rejects workspace-relative paths.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { absolutize } from './paths.js'

interface FilesResponse {
  workspace: string
  files: string[]
}

const S = {
  page: { height: '100%', overflowY: 'auto', padding: '10px 8px', color: 'var(--ds-fg, #e6e6e6)', fontSize: 13 } as const,
  row: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-all' } as const,
  rowDir: { opacity: 0.4 } as const,
  dim: { opacity: 0.6, padding: 16, lineHeight: 1.7 } as const,
  btn: { marginTop: 10, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--ds-border, #2a2d34)', background: 'var(--ds-bg-raised, #1b1d22)', color: 'inherit', cursor: 'pointer', fontSize: 13 } as const,
} as const

export interface ProductsPanelProps {
  /** The dsh session whose omicos products to list. */
  sessionId?: string
  /** Sidebar mount: stop polling while the panel is hidden. */
  paused?: boolean
  /** The host's file open (the sidebar's own editor/viewer). */
  onOpenFile?: (path: string) => void
}

export function ProductsPanel({ sessionId, paused, onOpenFile }: ProductsPanelProps): JSX.Element {
  const [data, setData] = useState<FilesResponse | undefined>()
  const [status, setStatus] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading')
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    if (sessionId === undefined) return
    try {
      const res = await fetch(`/omicos/files/${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (!alive.current) return
      if (res.status === 404) {
        setStatus('empty')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as FilesResponse
      setData(body)
      setStatus(body.files.length === 0 ? 'empty' : 'ready')
    } catch {
      if (alive.current) setStatus('error')
    }
  }, [sessionId])

  useEffect(() => {
    alive.current = true
    if (paused === true) {
      return () => {
        alive.current = false
      }
    }
    void refresh()
    // Analyses finish while the panel is open — refresh on a lazy cadence.
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh, paused])

  if (status === 'loading') return <div style={S.dim}>加载中…</div>
  if (status === 'error') {
    return (
      <div style={S.dim}>
        产物列表获取失败（omicos 宿主不可达？）——每 5 秒自动重试中。
        <div>
          <button type="button" style={S.btn} onClick={() => void refresh()}>
            立即重新加载
          </button>
        </div>
      </div>
    )
  }
  if (status === 'empty' || data === undefined) {
    return <div style={S.dim}>本会话还没有 omicos 分析产物。跑一次分析后这里会列出全部生成的文件。</div>
  }

  return (
    <div style={S.page}>
      {data.files.map((path) => {
        const slash = path.lastIndexOf('/')
        const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
        const base = slash >= 0 ? path.slice(slash + 1) : path
        return (
          <button
            key={path}
            type="button"
            style={S.row}
            title={onOpenFile ? `打开 ${path}` : path}
            onClick={onOpenFile ? () => onOpenFile(absolutize(path, data.workspace)) : undefined}
          >
            {dir !== '' && <span style={S.rowDir}>{dir}</span>}
            {base}
          </button>
        )
      })}
    </div>
  )
}
