import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScienceSnapshot } from '../oss/types.js'
import { api } from './oss-api.js'

/** Snapshot + durable invalidation stream, with bounded polling only as recovery. */
export function useScienceSnapshot(projectId: string, language: 'python' | 'r') {
  const [snapshot, setSnapshot] = useState<ScienceSnapshot>()
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const identity = useRef(`${projectId}:${language}`)
  identity.current = `${projectId}:${language}`
  const refresh = useCallback(async () => { const expected = `${projectId}:${language}`; const value = await api<ScienceSnapshot>(`project/${projectId}/snapshot?language=${language}`); if (identity.current === expected) setSnapshot(value) }, [projectId, language])
  useEffect(() => {
    const abort = new AbortController(); let source: EventSource | undefined
    let debounce: ReturnType<typeof setTimeout>; let running = false; let dirty = false; let live = false
    const load = async () => {
      if (running) { dirty = true; return }
      running = true
      try {
        const value = await api<ScienceSnapshot>(`project/${projectId}/snapshot?language=${language}`, undefined, abort.signal)
        if (abort.signal.aborted) return
        setSnapshot(value); setError('')
        if (!source) {
          source = new EventSource(`/omicos/oss/api/project/${projectId}/events?after=${value.eventCursor}`)
          source.onopen = () => { live = true; setConnection('live'); void load() }
          source.onerror = () => { live = false; setConnection('reconnecting') }
          const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => void load(), 150) }
          source.addEventListener('scientific', changed); source.addEventListener('reset', changed)
        }
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
      finally { running = false; if (dirty && !abort.signal.aborted) { dirty = false; void load() } }
    }
    setConnection('connecting'); setSnapshot(undefined); void load()
    let ticks = 0
    const recovery = setInterval(() => { ticks++; if (!document.hidden && (!live || ticks % 5 === 0)) void load() }, 2000)
    return () => { abort.abort(); source?.close(); clearTimeout(debounce); clearInterval(recovery) }
  }, [projectId, language])
  return { snapshot, error, connection, refresh }
}
