import { describe, expect, it } from 'vitest'
import { billingDomain, memberships, expiryReminders } from '../src/oss/membership.js'
const row = { domain: 'omics', plan_code: 'pro', expires_at: '2026-11-01T00:00:00Z', auto_renew: 0, cancelled_at: null }
describe('official membership wire contracts', () => {
  it('projects only lifecycle fields and preserves separate domain/source classifications', () => {
    const data = memberships({ subscriptions: [{ ...row, kind: 'annual', period_months: 12, user_token: 'never-return' }, { ...row, domain: 'humanities_social', kind: 'trial', auto_renew: 1 }] })
    expect(data.subscriptions.map(item => item.auto_renew)).toEqual([false, true])
    expect(data.subscriptions[0].kind).toBe('annual'); expect(data.subscriptions[1].kind).toBe('trial')
    expect(JSON.stringify(data)).not.toContain('never-return')
    expect(expiryReminders({ reminders: [{ ...row, state: 'expiring_soon', days_left: 3 }] }).reminders[0].expires_at).toBe(row.expires_at)
    expect(memberships({ subscriptions: [{ ...row, auto_renew: true }] }).subscriptions[0].auto_renew).toBe(true)
  })
  it('never converts malformed/duplicate membership records into an empty subscription list', () => {
    expect(() => memberships({})).toThrow(/不能将查询失败/)
    expect(() => memberships({ subscriptions: [row, row] })).toThrow(/重复/)
    expect(() => memberships({ subscriptions: [{ ...row, expires_at: 'unknown' }] })).toThrow(/expires_at/)
    expect(() => memberships({ subscriptions: [{ ...row, auto_renew: 'false' }] })).toThrow(/续订状态/)
    expect(() => expiryReminders({ reminders: [{ ...row, state: 'unknown', days_left: 3 }] })).toThrow(/提醒状态/)
    expect(() => expiryReminders({ reminders: [{ ...row, state: 'expired', days_left: -3 }] })).toThrow(/提醒状态/)
    expect(memberships({ subscriptions: [] })).toEqual({ subscriptions: [] })
    expect(expiryReminders({ reminders: [] })).toEqual({ reminders: [] })
  })
  it('accepts explicit service domains while rejecting query injection or ambiguous values', () => {
    expect(billingDomain('humanities_social')).toBe('humanities_social'); expect(billingDomain('')).toBeUndefined()
    for (const invalid of ['omics&domain=other', '../omics', ' omics ', {}, null]) expect(() => billingDomain(invalid)).toThrow(/服务域/)
  })
})
it('discards delayed membership/expiry responses when the Host cloud account changes', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { CloudService } = await import('../src/oss/cloud.js')
  const directory = await mkdtemp(join(tmpdir(), 'oss-membership-race-'))
  try {
    const file = join(directory, 'cloud.json'); await writeFile(file, JSON.stringify({ server: 'https://auth.example.invalid', token: 'synthetic-fixture', user: { id: 'old-owner' } }))
    let release!: (response: Response) => void
    const cloud = await CloudService.open('https://auth.example.invalid', file, async () => new Promise<Response>(resolve => { release = resolve }))
    const pending = cloud.subscriptions(); const rejected = expect(pending).rejects.toMatchObject({ status: 409 })
    await cloud.logout(); release(new Response(JSON.stringify({ subscriptions: [{ ...row, source_order_id: 'private-old-owner' }] })))
    await rejected
    await expect(cloud.reminders()).rejects.toMatchObject({ status: 401 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('refuses an explicit-domain mutation when an older cloud ignores the domain query', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { CloudService } = await import('../src/oss/cloud.js')
  const directory = await mkdtemp(join(tmpdir(), 'oss-membership-domain-')); const requests: Array<{ url: string; method?: string }> = []
  try {
    const file = join(directory, 'cloud.json'); await writeFile(file, JSON.stringify({ server: 'https://auth.example.invalid', token: 'synthetic-fixture', user: { id: 'owner' } }))
    const cloud = await CloudService.open('https://auth.example.invalid', file, async (url, init) => { requests.push({ url: String(url), method: init?.method }); return new Response(JSON.stringify({ active: true, domain: 'omics', subscription: { plan_code: 'pro' } })) })
    await expect(cloud.manageSubscription('cancel', 'humanities_social')).rejects.toMatchObject({ status: 409 })
    expect(requests).toHaveLength(1); expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toContain('?domain=humanities_social')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
