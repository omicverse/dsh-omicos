/** Geometry for the memory galaxy: a deterministic 3D tree layout, a perspective camera and hit testing. */

export type Vec3 = readonly [number, number, number]

export interface GalaxyNode {
  id: string
  parentId: string | null
}

export interface Camera {
  yaw: number
  pitch: number
  dist: number
  target: Vec3
}

export interface Projected {
  x: number
  y: number
  /** Depth after the camera transform; smaller is nearer. */
  z: number
  /** Perspective scale: 1 at the target's depth. */
  s: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const LEVEL_LENGTH = [150, 96, 62, 44]
const CONE = (62 * Math.PI) / 180

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2])
  return length === 0 ? [0, 1, 0] : [a[0] / length, a[1] / length, a[2] / length]
}

/** Points spread evenly over a sphere, in a stable order. */
function fibonacciSphere(count: number): Vec3[] {
  return Array.from({ length: count }, (_, index) => {
    const y = count === 1 ? 0 : 1 - (2 * index) / (count - 1)
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const angle = index * GOLDEN_ANGLE
    return [Math.cos(angle) * radius, y, Math.sin(angle) * radius] as Vec3
  })
}

/**
 * Place a parent/child forest in 3D. Top-level nodes sit on a sphere around the
 * origin; every child leaves its parent inside a cone that opens away from the
 * origin, so branches fan out instead of folding back. The result depends only
 * on the ids and their parent links, never on array order of siblings beyond
 * their id sort, so refreshes do not shuffle the picture.
 */
export function layoutGalaxy(nodes: readonly GalaxyNode[]): Map<string, Vec3> {
  const ids = new Set(nodes.map((node) => node.id))
  const children = new Map<string | null, string[]>()
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) && node.parentId !== node.id ? node.parentId : null
    const siblings = children.get(parent)
    if (siblings) siblings.push(node.id)
    else children.set(parent, [node.id])
  }
  for (const list of children.values()) list.sort()
  const positions = new Map<string, Vec3>()
  const roots = children.get(null) ?? []
  const rootRadius = roots.length <= 1 ? 0 : 70 + 26 * Math.sqrt(roots.length)
  fibonacciSphere(roots.length).forEach((direction, index) => {
    positions.set(roots[index]!, scale(direction, rootRadius))
  })
  const place = (id: string, depth: number, seen: Set<string>): void => {
    if (seen.has(id)) return
    seen.add(id)
    const origin = positions.get(id)!
    const kids = children.get(id) ?? []
    if (kids.length === 0) return
    const outward = unit(origin[0] === 0 && origin[1] === 0 && origin[2] === 0 ? [0, 1, 0] : origin)
    const helper: Vec3 = Math.abs(outward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = unit(cross(outward, helper))
    const v = cross(outward, u)
    const length = LEVEL_LENGTH[Math.min(depth, LEVEL_LENGTH.length - 1)]!
    kids.forEach((kid, index) => {
      const t = (index + 0.5) / kids.length
      const polar = CONE * Math.sqrt(t)
      const azimuth = index * GOLDEN_ANGLE
      const lateral = add(scale(u, Math.cos(azimuth)), scale(v, Math.sin(azimuth)))
      const direction = add(scale(outward, Math.cos(polar)), scale(lateral, Math.sin(polar)))
      positions.set(kid, add(origin, scale(direction, length * (0.85 + 0.3 * t))))
      place(kid, depth + 1, seen)
    })
  }
  const seen = new Set<string>()
  for (const root of roots) place(root, 0, seen)
  return positions
}

/** Farthest distance of any node from the origin: sets the resting camera distance. */
export function galaxyRadius(positions: ReadonlyMap<string, Vec3>): number {
  let radius = 60
  for (const [x, y, z] of positions.values()) radius = Math.max(radius, Math.hypot(x, y, z))
  return radius
}

/** Perspective-project one point for a viewport of `width` × `height`. */
export function project(point: Vec3, camera: Camera, width: number, height: number): Projected {
  const x0 = point[0] - camera.target[0]
  const y0 = point[1] - camera.target[1]
  const z0 = point[2] - camera.target[2]
  const cosY = Math.cos(camera.yaw)
  const sinY = Math.sin(camera.yaw)
  const x1 = x0 * cosY + z0 * sinY
  const z1 = -x0 * sinY + z0 * cosY
  const cosP = Math.cos(camera.pitch)
  const sinP = Math.sin(camera.pitch)
  const y2 = y0 * cosP - z1 * sinP
  const z2 = y0 * sinP + z1 * cosP
  const depth = z2 + camera.dist
  const focal = Math.min(width, height) * 0.9
  const s = depth <= 1 ? 0 : focal / depth
  return { x: width / 2 + x1 * s, y: height / 2 - y2 * s, z: depth, s: s === 0 ? 0 : (s * camera.dist) / focal }
}

/** Nearest visible node to a pointer within `slack` px of its drawn radius, nearer nodes winning ties. */
export function pickNode(
  projected: ReadonlyMap<string, Projected>,
  radii: ReadonlyMap<string, number>,
  x: number,
  y: number,
  slack = 5
): string | undefined {
  let best: string | undefined
  let bestScore = Infinity
  for (const [id, point] of projected) {
    if (point.s === 0) continue
    const reach = (radii.get(id) ?? 4) + slack
    const distance = Math.hypot(point.x - x, point.y - y)
    if (distance > reach) continue
    const score = distance + point.z * 0.002
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

/** Ancestors of `id` from the root down to `id` itself; cycles and missing parents end the walk. */
export function pathToRoot(nodes: readonly GalaxyNode[], id: string): string[] {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId] as const))
  const path: string[] = []
  const seen = new Set<string>()
  let current: string | null | undefined = id
  while (current && parentOf.has(current) && !seen.has(current)) {
    seen.add(current)
    path.unshift(current)
    current = parentOf.get(current)
  }
  return path
}
