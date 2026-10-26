import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  galaxyRadius,
  layoutGalaxy,
  pathToRoot,
  pickNode,
  project,
  type Camera,
  type Projected,
  type Vec3
} from './memory-galaxy.js'

export interface GalaxyEntry {
  id: string
  title: string
  kind: 'topic' | 'fact' | 'summary'
  state: 'proposed' | 'confirmed' | 'withdrawn' | 'superseded'
  parentId: string | null
  effective: boolean
}
export type GalaxyMode = 'roam' | 'focus'
export const STATE_LABELS = { proposed: '待确认', confirmed: '已确认', withdrawn: '已撤回', superseded: '已被替代' } as const
export const SCOPE_LABELS = { project: '项目共享', session: '指定会话', longterm: '项目内长期记忆' } as const

const BASE_RADIUS = { topic: 6, summary: 4.6, fact: 3.2 } as const
const AMBER = '#d99a1e'
const KIND_LABEL = { topic: '主题', fact: '事实', summary: '整合摘要' } as const
const STATE_LABEL = STATE_LABELS

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Interactive 3D constellation of the memory tree; canvas only, the list view is its accessible twin. */
export function MemoryGalaxy({
  entries,
  selectedId,
  mode,
  showProposals,
  visible,
  onSelect
}: {
  entries: readonly GalaxyEntry[]
  selectedId: string
  mode: GalaxyMode
  showProposals: boolean
  visible: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; id: string }>()
  const shown = useMemo(
    () => entries.filter((entry) => showProposals || entry.state !== 'proposed'),
    [entries, showProposals]
  )
  const byId = useMemo(() => new Map(shown.map((entry) => [entry.id, entry])), [shown])
  const positions = useMemo(() => layoutGalaxy(shown), [shown])
  const home = useMemo(() => galaxyRadius(positions) * 2.1 + 70, [positions])
  const live = useRef({
    camera: { yaw: 0.6, pitch: -0.22, dist: 400, target: [0, 0, 0] as Vec3 } as Camera,
    goal: undefined as { target: Vec3; dist: number } | undefined,
    drag: undefined as { x: number; y: number; yaw: number; pitch: number; moved: boolean } | undefined,
    hover: '',
    idleSince: 0,
    projected: new Map<string, Projected>(),
    radii: new Map<string, number>(),
    width: 0,
    height: 0
  })
  const props = useRef({ shown, byId, positions, home, selectedId, mode })
  props.current = { shown, byId, positions, home, selectedId, mode }

  // Frame the whole constellation when the data changes, or the selected node in focus mode.
  useEffect(() => {
    const state = live.current
    const point = selectedId ? positions.get(selectedId) : undefined
    state.goal =
      mode === 'focus' && point
        ? { target: point, dist: Math.max(120, home * 0.42) }
        : { target: [0, 0, 0], dist: home }
    state.idleSince = performance.now()
  }, [selectedId, mode, positions, home])

  const resize = useCallback(() => {
    const element = stage.current
    const surface = canvas.current
    if (!element || !surface) return
    const ratio = window.devicePixelRatio || 1
    const state = live.current
    state.width = element.clientWidth
    state.height = element.clientHeight
    surface.width = Math.max(1, Math.round(state.width * ratio))
    surface.height = Math.max(1, Math.round(state.height * ratio))
    surface.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0)
  }, [])
  useEffect(() => {
    const element = stage.current
    if (!element) return
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [resize])

  useEffect(() => {
    if (!visible) return
    const state = live.current
    state.camera.dist = props.current.home
    let frame = 0
    const color = (name: string, fallback: string): string =>
      (canvas.current ? getComputedStyle(canvas.current).getPropertyValue(name).trim() : '') || fallback
    const draw = (): void => {
      frame = requestAnimationFrame(draw)
      const surface = canvas.current
      const context = surface?.getContext('2d')
      const { width, height, camera } = state
      if (!context || !width || !height) return
      const { shown, byId, positions, selectedId } = props.current
      if (state.goal) {
        const k = reducedMotion() ? 1 : 0.08
        camera.target = camera.target.map((value, index) => value + (state.goal!.target[index]! - value) * k) as unknown as Vec3
        camera.dist += (state.goal.dist - camera.dist) * k
      }
      if (!reducedMotion() && !state.drag && !state.hover && !selectedId && performance.now() - state.idleSince > 2500) camera.yaw += 0.0009
      const brand = color('--omicos-brand', '#4c7a69')
      const muted = color('--omicos-muted', '#76847d')
      const ink = color('--omicos-text', '#1b231f')
      context.clearRect(0, 0, width, height)
      state.projected = new Map()
      for (const entry of shown) {
        const point = positions.get(entry.id)
        if (point) state.projected.set(entry.id, project(point, camera, width, height))
      }
      const depths = [...state.projected.values()].map((point) => point.z)
      const near = Math.min(...depths, Infinity)
      const far = Math.max(...depths, -Infinity) + 1
      const fog = (z: number): number => (far === near ? 1 : 0.5 + 0.5 * (1 - (z - near) / (far - near)))
      const trail = new Set(selectedId ? pathToRoot(shown, selectedId) : [])
      const edges = shown
        .filter((entry) => entry.parentId && state.projected.has(entry.parentId) && state.projected.has(entry.id))
        .map((entry) => [entry.parentId!, entry.id] as const)
        .sort((a, b) => state.projected.get(b[1])!.z - state.projected.get(a[1])!.z)
      for (const [from, to] of edges) {
        const a = state.projected.get(from)!
        const b = state.projected.get(to)!
        if (a.s === 0 || b.s === 0) continue
        const onTrail = trail.has(from) && trail.has(to)
        context.beginPath()
        context.moveTo(a.x, a.y)
        context.lineTo(b.x, b.y)
        context.setLineDash(onTrail ? [5, 4] : [])
        context.strokeStyle = brand
        context.globalAlpha = (onTrail ? 0.95 : 0.32) * fog((a.z + b.z) / 2)
        context.lineWidth = onTrail ? 1.8 : 0.9
        context.stroke()
      }
      context.setLineDash([])
      state.radii = new Map()
      const order = [...state.projected.entries()].sort((a, b) => b[1].z - a[1].z)
      for (const [id, point] of order) {
        const entry = byId.get(id)
        if (!entry || point.s === 0) continue
        const radius = BASE_RADIUS[entry.kind] * Math.max(0.6, Math.min(1.7, point.s * 1.25))
        state.radii.set(id, radius)
        const alpha = fog(point.z)
        if (id === selectedId) {
          context.globalAlpha = 0.14
          context.beginPath()
          context.arc(point.x, point.y, radius * 3.2, 0, 7)
          context.fillStyle = brand
          context.fill()
          context.globalAlpha = 0.7
          context.beginPath()
          context.arc(point.x, point.y, radius * 2, 0, 7)
          context.strokeStyle = brand
          context.lineWidth = 1
          context.stroke()
        }
        context.globalAlpha = alpha
        context.beginPath()
        if (entry.kind === 'summary') {
          context.moveTo(point.x, point.y - radius * 1.2)
          context.lineTo(point.x + radius * 1.2, point.y)
          context.lineTo(point.x, point.y + radius * 1.2)
          context.lineTo(point.x - radius * 1.2, point.y)
          context.closePath()
        } else context.arc(point.x, point.y, radius, 0, 7)
        if (entry.state === 'proposed') {
          context.setLineDash([2, 2])
          context.strokeStyle = AMBER
          context.lineWidth = 1.6
          context.stroke()
          context.setLineDash([])
        } else if (entry.state === 'confirmed' && entry.effective) {
          context.fillStyle = brand
          context.fill()
        } else {
          context.globalAlpha = alpha * 0.45
          context.fillStyle = muted
          context.fill()
        }
      }
      context.globalAlpha = 1
      context.font = '12px system-ui, sans-serif'
      context.textBaseline = 'middle'
      const placed: Array<[number, number, number, number]> = []
      const priority = (id: string): number =>
        (id === selectedId || id === state.hover ? 1e6 : 0) +
        (trail.has(id) ? 1e5 : 0) +
        (byId.get(id)?.kind === 'topic' ? 1e4 : 0) -
        (state.projected.get(id)?.z ?? 0)
      for (const id of [...state.projected.keys()].sort((a, b) => priority(b) - priority(a))) {
        const entry = byId.get(id)
        const point = state.projected.get(id)
        if (!entry || !point || point.s === 0) continue
        const wanted = id === selectedId || id === state.hover || trail.has(id) || entry.kind === 'topic'
        if (!wanted) continue
        const text = entry.title.length > 18 ? `${entry.title.slice(0, 17)}…` : entry.title
        const textWidth = context.measureText(text).width
        const x = point.x + (state.radii.get(id) ?? 4) + 6
        const box: [number, number, number, number] = [x - 2, point.y - 9, x + textWidth + 2, point.y + 9]
        if (priority(id) < 1e5 && placed.some((other) => !(box[2] < other[0] || box[0] > other[2] || box[3] < other[1] || box[1] > other[3]))) continue
        placed.push(box)
        context.globalAlpha = Math.max(0.6, fog(point.z))
        context.fillStyle = id === selectedId ? brand : ink
        context.font = `${id === selectedId || entry.kind === 'topic' ? '600 ' : ''}12px system-ui, sans-serif`
        context.fillText(text, x, point.y)
      }
      context.globalAlpha = 1
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [visible])

  const locate = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = canvas.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const move = (event: React.PointerEvent): void => {
    const state = live.current
    const { x, y } = locate(event)
    if (state.drag) {
      const dx = x - state.drag.x
      const dy = y - state.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true
      state.camera.yaw = state.drag.yaw - dx * 0.006
      state.camera.pitch = Math.max(-1.4, Math.min(1.4, state.drag.pitch + dy * 0.006))
      setTip(undefined)
      return
    }
    const id = pickNode(state.projected, state.radii, x, y) ?? ''
    if (id !== state.hover) {
      state.hover = id
      setTip(id ? { x, y, id } : undefined)
    }
  }
  const down = (event: React.PointerEvent): void => {
    const state = live.current
    const { x, y } = locate(event)
    state.drag = { x, y, yaw: state.camera.yaw, pitch: state.camera.pitch, moved: false }
    state.idleSince = performance.now()
    canvas.current?.setPointerCapture(event.pointerId)
  }
  const up = (event: React.PointerEvent): void => {
    const state = live.current
    const drag = state.drag
    state.drag = undefined
    state.idleSince = performance.now()
    if (!drag || drag.moved) return
    const { x, y } = locate(event)
    onSelect(pickNode(state.projected, state.radii, x, y) ?? '')
  }
  const wheel = (event: React.WheelEvent): void => {
    const state = live.current
    const next = state.camera.dist * (event.deltaY > 0 ? 1.1 : 0.9)
    const floor = Math.max(60, props.current.home * 0.25)
    state.camera.dist = Math.max(floor, Math.min(props.current.home * 2.2, next))
    if (state.goal) state.goal = { ...state.goal, dist: state.camera.dist }
    state.idleSince = performance.now()
  }
  const key = (event: React.KeyboardEvent): void => {
    const camera = live.current.camera
    const step = 0.12
    if (event.key === 'ArrowLeft') camera.yaw -= step
    else if (event.key === 'ArrowRight') camera.yaw += step
    else if (event.key === 'ArrowUp') camera.pitch = Math.max(-1.4, camera.pitch - step)
    else if (event.key === 'ArrowDown') camera.pitch = Math.min(1.4, camera.pitch + step)
    else if (event.key === '+' || event.key === '=') camera.dist = Math.max(60, camera.dist * 0.9)
    else if (event.key === '-') camera.dist = Math.min(props.current.home * 2.2, camera.dist * 1.1)
    else return
    event.preventDefault()
    live.current.idleSince = performance.now()
  }
  const hovered = tip ? byId.get(tip.id) : undefined
  return (
    <div ref={stage} className="omicos-galaxy">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="img"
        aria-label={`记忆星图：${shown.length} 个节点。可用方向键旋转、加减号缩放；也可切换到列表查看。`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => {
          live.current.hover = ''
          setTip(undefined)
        }}
        onWheel={wheel}
        onKeyDown={key}
      />
      {hovered && tip ? (
        <div className="omicos-galaxy-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{hovered.title}</strong>
          <span>
            {KIND_LABEL[hovered.kind]} · {STATE_LABEL[hovered.state]}
          </span>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="omicos-galaxy-empty">
          <strong>还没有记忆</strong>
          <span>在右侧写下第一条事实或主题，确认后它会出现在星图里。</span>
        </div>
      ) : null}
    </div>
  )
}
