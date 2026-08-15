/**
 * Keyed takeover of the `omicos_analyze` tool card (`tool.call.toolview`,
 * D8's no-node-definition path — deliberately NOT custom SessionEvents,
 * which would brick session reload; see host/activity-store.ts).
 *
 * RUNNING: polls `/omicos/activity/<callId>` (~700ms) and renders the
 * nested omicos agent's live state — phase, current tool, executing
 * statement lines, stdout tail, tqdm bars. Every snapshot is
 * self-contained, so a missed poll never corrupts the view.
 *
 * SETTLED: renders the result's text blocks + figures. Figure bytes come
 * from `/omicos/figure?ws=&path=` using the DURABLE paths in
 * `result.meta.omicos.generated_files` (presentationMeta) + the owner's
 * `cwd` — so settled cards keep their images across dsh host restarts.
 */
import { useEffect, useRef, useState } from 'react'

interface ActivitySnapshot {
  n: number
  phase: 'thinking' | 'tool' | 'done'
  tool?: string
  execLines?: { start: number; end: number }
  stdoutTail?: string
  progress?: string[]
  outcome?: 'ok' | 'error' | 'cancelled'
  error?: string
}

interface ActivityFeed {
  running: boolean
  snapshot?: ActivitySnapshot
}

/** Structural mirror of ToolCallOwnerProps (ui-tool contract) — the fields this view consumes. */
interface OwnerProps {
  callId: string
  toolName: string
  block: {
    kind?: string
    content?: ReadonlyArray<{ type: string; text?: string }>
    isError?: boolean
    meta?: { omicos?: { generated_files?: string[] } }
  }
  cwd?: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

const S = {
  card: { border: '1px solid var(--ds-border, #2a2d34)', borderRadius: 8, padding: '10px 14px', margin: '4px 0', background: 'var(--ds-bg-raised, #1b1d22)', fontSize: 13, lineHeight: 1.6 } as const,
  head: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } as const,
  badge: { padding: '0 8px', borderRadius: 4, fontSize: 12, background: '#233a52', color: '#8fc2f5' } as const,
  badgeDone: { padding: '0 8px', borderRadius: 4, fontSize: 12, background: '#2b4a2f', color: '#9be29f' } as const,
  badgeErr: { padding: '0 8px', borderRadius: 4, fontSize: 12, background: '#4a2b2b', color: '#e0705f' } as const,
  dim: { opacity: 0.65 } as const,
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--ds-bg, #14161a)', borderRadius: 6, padding: '6px 10px', marginTop: 6, maxHeight: 180, overflowY: 'auto' } as const,
  progress: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#8fc2f5' } as const,
  img: { maxWidth: '100%', maxHeight: 420, borderRadius: 6, marginTop: 8, background: '#fff', display: 'block' } as const,
  err: { color: '#e0705f' } as const,
} as const

const PHASE_LABEL: Record<ActivitySnapshot['phase'], string> = {
  thinking: 'omicos 思考中',
  tool: 'omicos 执行中',
  done: 'omicos 完成',
}

function RunningView({ callId }: { callId: string }): JSX.Element {
  const [feed, setFeed] = useState<ActivityFeed | undefined>()
  const [unavailable, setUnavailable] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/omicos/activity/${encodeURIComponent(callId)}`, { cache: 'no-store' })
        if (!alive.current || stopped) return
        if (res.status === 404) {
          setUnavailable(true)
          return
        }
        if (res.ok) {
          setFeed((await res.json()) as ActivityFeed)
          setUnavailable(false)
        }
      } catch {
        // transient; next tick retries
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 700)
    return () => {
      alive.current = false
      stopped = true
      clearInterval(timer)
    }
  }, [callId])

  const snap = feed?.snapshot
  return (
    <div style={S.card}>
      <div style={S.head}>
        <span style={snap?.phase === 'done' ? (snap.outcome === 'ok' ? S.badgeDone : S.badgeErr) : S.badge}>
          {snap ? PHASE_LABEL[snap.phase] : 'omicos 启动中'}
        </span>
        {snap?.tool !== undefined && (
          <span style={S.dim}>
            {snap.tool}
            {snap.execLines !== undefined && `（第 ${snap.execLines.start}${snap.execLines.end !== snap.execLines.start ? `-${snap.execLines.end}` : ''} 句）`}
          </span>
        )}
      </div>
      {snap?.progress !== undefined && snap.progress.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {snap.progress.map((line) => (
            <div key={line} style={S.progress}>▸ {line}</div>
          ))}
        </div>
      )}
      {snap?.stdoutTail !== undefined && <div style={S.mono}>{snap.stdoutTail}</div>}
      {snap?.error !== undefined && <div style={S.err}>{snap.error}</div>}
      {unavailable && <div style={S.dim}>实时活动不可用（宿主重启或任务尚未上报）。</div>}
    </div>
  )
}

function SettledView({ block, cwd }: { block: OwnerProps['block']; cwd?: string }): JSX.Element {
  const text = (block.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
  const figures = (block.meta?.omicos?.generated_files ?? []).filter((p) => IMAGE_EXT.test(p))
  return (
    <div style={S.card}>
      <div style={S.head}>
        <span style={block.isError ? S.badgeErr : S.badgeDone}>{block.isError ? 'omicos 失败' : 'omicos 完成'}</span>
      </div>
      {text !== '' && <div style={{ ...(block.isError ? S.err : {}), whiteSpace: 'pre-wrap', marginTop: 4 }}>{text}</div>}
      {cwd !== undefined &&
        figures.map((path) => (
          <img
            key={path}
            style={S.img}
            src={`/omicos/figure?ws=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`}
            alt={path}
          />
        ))}
    </div>
  )
}

export function OmicosToolView(props: unknown): JSX.Element {
  const { callId, block, cwd } = props as OwnerProps
  const settled = block !== undefined && 'kind' in block && block.kind === 'tool-result'
  return settled ? <SettledView block={block} cwd={cwd} /> : <RunningView callId={callId} />
}
