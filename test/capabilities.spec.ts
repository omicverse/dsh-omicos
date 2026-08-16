import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEntry, SkillEntry } from '@omicverse/omicos-protocol'
import { CapabilityIndex, searchCatalog, tokenize } from '../src/host/capabilities.js'

function skill(over: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: 'demo-skill',
    title: 'Demo skill',
    description: 'A demo skill.',
    tier: 'community',
    custom: false,
    source_path: '/Users/someone/.omicos/cloud-skills/skills/demo/SKILL.md',
    category: 'transcriptomics',
    category_order: 30,
    summary: '演示技能',
    use_when: 'Use when demonstrating.',
    ...over,
  }
}

function agent(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: 'demo-agent',
    name: 'Demo agent',
    description: 'A demo agent.',
    tier: 'community',
    category: 'data_acquisition',
    category_order: 1,
    summary: '演示智能体',
    use_when: 'Use when demonstrating.',
    ...over,
  }
}

describe('tokenize', () => {
  it('splits latin words and emits CJK bigrams so a longer query still matches a shorter phrase', () => {
    expect(tokenize('spatial deconvolution').map((t) => t.text)).toEqual(['spatial', 'deconvolution'])
    const cjk = tokenize('空间转录组')
    expect(cjk.filter((t) => t.primary).map((t) => t.text)).toEqual(['空间转录组'])
    expect(cjk.filter((t) => !t.primary).map((t) => t.text)).toEqual(['空间', '间转', '转录', '录组'])
  })

  it('a longer CJK query still reaches an entry that only carries the shorter phrase', () => {
    // The whole run "空间转录组" is absent from the entry; the bigrams carry it.
    const found = searchCatalog({ skills: [skill({ id: 'st', summary: '空间转录数据分析', use_when: '' })], agents: [] }, '空间转录组')
    expect(found.results.map((r) => r.id)).toEqual(['st'])
  })

  it('drops one-character latin noise but keeps whole CJK runs', () => {
    expect(tokenize('a of').map((t) => t.text)).toEqual(['of'])
    expect(tokenize('组').map((t) => t.text)).toEqual(['组'])
  })
})

describe('searchCatalog projection', () => {
  it('indexes use_when but never emits it, and never emits the local source_path', () => {
    // The query word exists ONLY in use_when — finding the entry proves the
    // field is indexed; the assertions below prove it does not travel.
    const secretPath = '/Users/someone/.omicos/cloud-skills/skills/velocity/SKILL.md'
    const found = searchCatalog(
      {
        skills: [
          skill({
            id: 'velo',
            title: 'Velocity',
            description: 'Estimates rates of change.',
            source_path: secretPath,
            use_when: 'Use for regvelo when the manifest names a splicing matrix.',
            summary: '速率估计',
          }),
        ],
        agents: [],
      },
      'regvelo',
    )

    expect(found.results.map((r) => r.id)).toEqual(['velo'])
    // `query` legitimately echoes the model's own word, so assert on the
    // catalog text AROUND it — that is what must not travel.
    const wire = JSON.stringify(found)
    expect(wire).not.toContain('splicing matrix')
    expect(wire).not.toContain('Use for')
    expect(wire).not.toContain(secretPath)
    expect(wire).not.toContain('.omicos')
  })

  it('a Chinese query reaches an English-described skill through the Chinese summary', () => {
    const found = searchCatalog(
      {
        skills: [
          skill({ id: 'spatial', title: 'Spatial mapping', description: 'Maps cells onto tissue.', summary: '空间转录组细胞定位', use_when: '' }),
          skill({ id: 'bulk', title: 'Bulk DE', description: 'Differential expression.', summary: '差异表达', use_when: '' }),
        ],
        agents: [],
      },
      '空间转录组',
    )
    expect(found.results.map((r) => r.id)).toEqual(['spatial'])
    expect(found.results[0]?.description).toBe('Maps cells onto tissue.')
    expect(JSON.stringify(found)).not.toContain('空间转录组细胞定位')
  })

  it('ranks a title match above a body that repeats the term', () => {
    const found = searchCatalog(
      {
        skills: [
          skill({ id: 'mentions', title: 'Something else', description: 'trajectory trajectory trajectory trajectory trajectory.', summary: '', use_when: '' }),
          skill({ id: 'named', title: 'Trajectory inference', description: 'Orders cells.', summary: '', use_when: '' }),
        ],
        agents: [],
      },
      'trajectory',
    )
    expect(found.results.map((r) => r.id)).toEqual(['named', 'mentions'])
  })

  it('a focused entry outranks a long catch-all that merely mentions the term', () => {
    // The live failure this encodes: broad agents whose blurbs name every
    // modality took the top slot for EVERY query, because a term that is
    // present counted the same whether the entry is about it or not.
    // The catch-all is deliberately the SHORTER entry, so neither presence
    // scoring nor the length tiebreak can produce this order — only
    // frequency ("about it") vs a single mention can.
    const found = searchCatalog(
      {
        skills: [
          skill({
            id: 'focused',
            title: 'A',
            description: `差异表达分析。差异表达统计检验与差异表达可视化。${'方法细节。'.repeat(12)}`,
            summary: '',
            use_when: '',
          }),
          skill({ id: 'catch-all', title: 'B', category: 'data_acquisition', category_order: 1, description: '下载、质控、聚类、注释、差异表达、富集。', summary: '', use_when: '' }),
        ],
        agents: [],
      },
      '差异表达',
    )
    expect(found.results.map((r) => r.id)).toEqual(['focused', 'catch-all'])
  })

  it('a term present in nearly every entry cannot decide the ranking', () => {
    // "analysis" / "分析" is filler in this catalog; only "wgcna" is a signal.
    const filler = Array.from({ length: 30 }, (_, i) => skill({ id: `f${i}`, title: `Analysis ${i}`, description: 'analysis of data', summary: '', use_when: '' }))
    const found = searchCatalog(
      { skills: [...filler, skill({ id: 'target', title: 'Co-expression networks', description: 'wgcna modules.', summary: '', use_when: '' })], agents: [] },
      'wgcna analysis',
    )
    expect(found.results[0]?.id).toBe('target')
  })

  it('truncates long descriptions instead of forwarding the full catalog prose', () => {
    const found = searchCatalog({ skills: [skill({ description: `${'x'.repeat(900)} deconvolution`, summary: '', use_when: '' })], agents: [] }, 'deconvolution')
    expect(found.results[0]?.description.length).toBeLessThan(260)
    expect(found.results[0]?.description.endsWith('…')).toBe(true)
  })
})

describe('searchCatalog behaviour', () => {
  it('answers an empty query with the category digest and no ranked results', () => {
    const found = searchCatalog({ skills: [skill(), skill({ id: 'b' })], agents: [agent()] }, '   ')
    expect(found.results).toEqual([])
    expect(found.categories).toEqual([
      { category: 'transcriptomics', skills: 2, agents: 0 },
      { category: 'data_acquisition', skills: 0, agents: 1 },
    ])
  })

  it('marks only the entries above the current plan as locked, and marks nothing when the plan is unknown', () => {
    const catalog = {
      skills: [skill({ id: 'free-one', tier: 'community', title: 'Cluster basic' }), skill({ id: 'pro-one', tier: 'pro', title: 'Cluster advanced' })],
      agents: [],
    }
    const gated = searchCatalog(catalog, 'cluster', { plan: 'plus' })
    expect(Object.fromEntries(gated.results.map((r) => [r.id, r.locked]))).toEqual({ 'free-one': undefined, 'pro-one': true })

    const ungated = searchCatalog(catalog, 'cluster')
    expect(ungated.results.every((r) => r.locked === undefined)).toBe(true)
  })

  it('clamps limit into 1..20 and reports what was indexed', () => {
    const skills = Array.from({ length: 40 }, (_, i) => skill({ id: `s${i}`, title: `Cluster ${i}` }))
    expect(searchCatalog({ skills, agents: [] }, 'cluster', { limit: 999 }).results).toHaveLength(20)
    expect(searchCatalog({ skills, agents: [] }, 'cluster', { limit: 0 }).results).toHaveLength(1)
    expect(searchCatalog({ skills, agents: [agent()] }, 'cluster').indexed).toEqual({ skills: 40, agents: 1 })
  })
})

describe('CapabilityIndex', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubFetch(impl: (path: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async (input: unknown) => impl(new URL(String(input)).pathname))
    globalThis.fetch = spy as unknown as typeof fetch
    return spy
  }

  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('fetches both catalogs once and serves the second load from cache', async () => {
    const spy = stubFetch((path) => (path === '/api/skills' ? json({ skills: [skill()] }) : json({ agents: [agent()] })))
    const index = new CapabilityIndex()

    const first = await index.load('http://127.0.0.1:5099')
    const second = await index.load('http://127.0.0.1:5099')

    expect(first).toBe(second)
    expect(spy).toHaveBeenCalledTimes(2) // skills + agents, not four calls
  })

  it('still returns the skills when the agent catalog fails', async () => {
    stubFetch((path) => (path === '/api/skills' ? json({ skills: [skill()] }) : new Response('nope', { status: 500 })))
    const catalog = await new CapabilityIndex().load('http://127.0.0.1:5099')
    expect(catalog.skills).toHaveLength(1)
    expect(catalog.agents).toEqual([])
  })

  it('does not cache a failure — the next load retries', async () => {
    let attempt = 0
    stubFetch((path) => {
      if (path !== '/api/skills') return json({ agents: [] })
      attempt += 1
      return attempt === 1 ? new Response('down', { status: 503 }) : json({ skills: [skill()] })
    })
    const index = new CapabilityIndex()
    await expect(index.load('http://127.0.0.1:5099')).rejects.toThrow()
    await expect(index.load('http://127.0.0.1:5099')).resolves.toMatchObject({ skills: [expect.objectContaining({ id: 'demo-skill' })] })
  })

  it('honours the TTL — an expired cache refetches', async () => {
    const spy = stubFetch((path) => (path === '/api/skills' ? json({ skills: [skill()] }) : json({ agents: [] })))
    const index = new CapabilityIndex(0)
    await index.load('http://127.0.0.1:5099')
    await index.load('http://127.0.0.1:5099')
    expect(spy).toHaveBeenCalledTimes(4)
  })
})
