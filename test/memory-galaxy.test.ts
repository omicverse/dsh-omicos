import { describe, expect, it } from 'vitest'
import {
  galaxyRadius,
  layoutGalaxy,
  pathToRoot,
  pickNode,
  project,
  type Camera,
  type GalaxyNode
} from '../src/client/memory-galaxy.js'

const forest: GalaxyNode[] = [
  { id: 'a', parentId: null },
  { id: 'a1', parentId: 'a' },
  { id: 'a2', parentId: 'a' },
  { id: 'a1x', parentId: 'a1' },
  { id: 'b', parentId: null },
  { id: 'orphan', parentId: 'missing' },
  { id: 'loop1', parentId: 'loop2' },
  { id: 'loop2', parentId: 'loop1' }
]
const camera: Camera = { yaw: 0, pitch: 0, dist: 400, target: [0, 0, 0] }

describe('memory galaxy geometry', () => {
  it('places every node once and is independent of input order', () => {
    const first = layoutGalaxy(forest)
    const second = layoutGalaxy([...forest].reverse())
    expect([...first.keys()].sort()).toEqual(forest.map((node) => node.id).filter((id) => id !== 'loop1' && id !== 'loop2').sort())
    for (const [id, point] of first) expect(second.get(id)).toEqual(point)
  })
  it('fans children away from their parent, farther from the origin', () => {
    const positions = layoutGalaxy(forest)
    const a = positions.get('a')!
    const a1 = positions.get('a1')!
    expect(Math.hypot(...a1)).toBeGreaterThan(Math.hypot(...a))
    expect(Math.hypot(a1[0] - a[0], a1[1] - a[1], a1[2] - a[2])).toBeGreaterThan(40)
    expect(galaxyRadius(positions)).toBeGreaterThan(Math.hypot(...a1) - 1)
  })
  it('keeps a lone node at the origin and handles an empty forest', () => {
    expect(layoutGalaxy([{ id: 'only', parentId: null }]).get('only')).toEqual([0, 0, 0])
    expect(layoutGalaxy([]).size).toBe(0)
  })
  it('projects the target to the viewport centre and points behind the camera hidden', () => {
    const centre = project([0, 0, 0], camera, 800, 600)
    expect([centre.x, centre.y, centre.s]).toEqual([400, 300, 1])
    expect(project([0, 0, -100], camera, 800, 600).s).toBeGreaterThan(centre.s)
    expect(project([0, 0, -500], camera, 800, 600).s).toBe(0)
  })
  it('picks the node under the pointer, preferring the nearer one on overlap', () => {
    const projected = new Map([
      ['far', { x: 100, y: 100, z: 500, s: 0.8 }],
      ['near', { x: 102, y: 100, z: 300, s: 1.2 }]
    ])
    const radii = new Map([['far', 5], ['near', 5]])
    expect(pickNode(projected, radii, 101, 100)).toBe('near')
    expect(pickNode(projected, radii, 300, 300)).toBeUndefined()
  })
  it('walks to the root and stops at cycles and missing parents', () => {
    expect(pathToRoot(forest, 'a1x')).toEqual(['a', 'a1', 'a1x'])
    expect(pathToRoot(forest, 'orphan')).toEqual(['orphan'])
    expect(pathToRoot(forest, 'loop1').length).toBeLessThanOrEqual(2)
    expect(pathToRoot(forest, 'nope')).toEqual([])
  })
})
