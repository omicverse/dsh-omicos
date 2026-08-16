/**
 * The「文件」session-view tab: every file the omicos analyses of THIS dsh
 * session produced, with inline preview — images and PDFs render in
 * place, textual files (csv/tsv/txt/json/md/log/yaml) show a bounded
 * text excerpt, anything else says so.
 *
 * Data: `GET /omicos/files/<dshSessionId>` (host probes its kernel pool
 * for the owning workspace) + `GET /omicos/file?ws=&path=` for bytes
 * (extension-allowlisted, loopback-pinned, 25MB cap host-side).
 *
 * Mounted twice: as the session-view「文件」tab (own registration) and, when
 * the user has the third-party better-sidebar installed, as a sidebar tab
 * (see `betterSidebar.ts`) — that surface passes `paused` while hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface FilesResponse {
  workspace: string
  files: string[]
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const PDF_EXT = /\.pdf$/i
const TEXT_EXT = /\.(csv|tsv|txt|json|md|log|yaml|yml)$/i
const TEXT_PREVIEW_CHARS = 60_000

const S = {
  page: { display: 'flex', height: '100%', minHeight: 480, color: 'var(--ds-fg, #e6e6e6)', fontSize: 13 } as const,
  list: { width: 300, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--ds-border, #2a2d34)', padding: '10px 8px' } as const,
  row: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-all' } as const,
  rowActive: { background: 'var(--ds-bg-raised, #1b1d22)' } as const,
  rowDir: { opacity: 0.4 } as const,
  preview: { flex: 1, overflow: 'auto', padding: 16 } as const,
  img: { maxWidth: '100%', borderRadius: 6, background: '#fff', display: 'block' } as const,
  pdf: { width: '100%', height: 'calc(100vh - 220px)', minHeight: 420, border: 'none', borderRadius: 6 } as const,
  text: { fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre', background: 'var(--ds-bg-raised, #1b1d22)', borderRadius: 6, padding: 12, overflowX: 'auto' } as const,
  dim: { opacity: 0.6 } as const,
  head: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.6, marginBottom: 10, wordBreak: 'break-all' } as const,
} as const

function fileUrl(workspace: string, path: string): string {
  return `/omicos/file?ws=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`
}

function TextPreview({ url }: { url: string }): JSX.Element {
  const [text, setText] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    setText(undefined)
    setError(undefined)
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.text()
        if (live) setText(body.length > TEXT_PREVIEW_CHARS ? `${body.slice(0, TEXT_PREVIEW_CHARS)}\n… (截断，完整内容请从会话卡的文件条打开)` : body)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [url])
  if (error !== undefined) return <div style={S.dim}>读取失败：{error}</div>
  if (text === undefined) return <div style={S.dim}>加载中…</div>
  return <pre style={S.text}>{text}</pre>
}

function Preview({ workspace, path }: { workspace: string; path: string }): JSX.Element {
  const url = fileUrl(workspace, path)
  if (IMAGE_EXT.test(path)) return <img style={S.img} src={url} alt={path} />
  if (PDF_EXT.test(path)) return <embed style={S.pdf} src={url} type="application/pdf" />
  if (TEXT_EXT.test(path)) return <TextPreview url={url} />
  return <div style={S.dim}>此类型暂不支持内嵌预览，请从会话卡的文件条用系统应用打开。</div>
}

export interface FilesTabProps {
  /** The dsh session whose omicos products to list. Slot mount: from the inject face (client/index.ts). */
  sessionId?: string
  /** Sidebar mount only: stop polling while the panel is hidden. */
  paused?: boolean
}

export function FilesTab({ sessionId, paused }: FilesTabProps): JSX.Element {
  const [data, setData] = useState<FilesResponse | undefined>()
  const [status, setStatus] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading')
  const [selected, setSelected] = useState<string | undefined>()
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
      setSelected((prev) => prev ?? body.files.find((f) => IMAGE_EXT.test(f)) ?? body.files[0])
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
    // Analyses finish while the tab is open — refresh on a lazy cadence.
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh, paused])

  if (status === 'loading') return <div style={{ ...S.dim, padding: 24 }}>加载中…</div>
  if (status === 'error') {
    return (
      <div style={{ padding: 24 }}>
        <div style={S.dim}>文件列表获取失败（omicos 宿主不可达？）——每 5 秒自动重试中。</div>
        <button
          type="button"
          style={{ marginTop: 10, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--ds-border, #2a2d34)', background: 'var(--ds-bg-raised, #1b1d22)', color: 'inherit', cursor: 'pointer', fontSize: 13 }}
          onClick={() => void refresh()}
        >
          立即重新加载
        </button>
      </div>
    )
  }
  if (status === 'empty' || data === undefined) {
    return <div style={{ ...S.dim, padding: 24 }}>本会话还没有 omicos 分析产物。跑一次分析后这里会列出全部生成的文件。</div>
  }

  return (
    <div style={S.page}>
      <div style={S.list}>
        {data.files.map((path) => {
          const slash = path.lastIndexOf('/')
          const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
          const base = slash >= 0 ? path.slice(slash + 1) : path
          return (
            <button
              key={path}
              type="button"
              style={{ ...S.row, ...(path === selected ? S.rowActive : {}) }}
              onClick={() => setSelected(path)}
              title={path}
            >
              {dir !== '' && <span style={S.rowDir}>{dir}</span>}
              {base}
            </button>
          )
        })}
      </div>
      <div style={S.preview}>
        {selected !== undefined ? (
          <>
            <div style={S.head}>{selected}</div>
            <Preview workspace={data.workspace} path={selected} />
          </>
        ) : (
          <div style={S.dim}>选择左侧文件预览。</div>
        )}
      </div>
    </div>
  )
}
