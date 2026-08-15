import { describe, expect, it } from 'vitest'
import { ActivityStore } from '../src/host/activity-store.js'
import type { ActivitySnapshot } from '../src/host/activity.js'

function snap(n: number, phase: ActivitySnapshot['phase'] = 'tool'): ActivitySnapshot {
  return { n, phase }
}

describe('ActivityStore', () => {
  it('publish keeps the latest snapshot per call and running tracks the phase', () => {
    const store = new ActivityStore({ now: () => 0 })
    store.publish('c1', snap(1))
    store.publish('c1', snap(2))
    expect(store.get('c1')).toMatchObject({ running: true, snapshot: { n: 2 } })
    store.publish('c1', { n: 3, phase: 'done', outcome: 'ok' })
    expect(store.get('c1')?.running).toBe(false)
  })

  it('finish() marks a run over even without a terminal snapshot (thrown turn)', () => {
    const store = new ActivityStore({ now: () => 0 })
    store.publish('c1', snap(1))
    store.finish('c1')
    expect(store.get('c1')).toMatchObject({ running: false, snapshot: { n: 1 } })
  })

  it('sweeps entries past the TTL and evicts oldest beyond the cap', () => {
    const clock = { t: 0 }
    const store = new ActivityStore({ ttlMs: 100, maxEntries: 2, now: () => clock.t })
    store.publish('old', snap(1))
    clock.t = 200
    store.publish('fresh', snap(1))
    expect(store.get('old')).toBeUndefined()

    store.publish('a', snap(1))
    clock.t = 201
    store.publish('b', snap(1))
    expect(store.get('fresh')).toBeUndefined()
    expect(store.get('a')).toBeDefined()
    expect(store.get('b')).toBeDefined()
  })
})
