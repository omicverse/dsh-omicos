/**
 * Retrieval over the omicos capability catalog — the substrate of the
 * `omicos_capabilities` tool.
 *
 * Why retrieval and not a listing: live on this machine the catalog is
 * 269 skills / 272 KB plus 97 agents. Handing that to a model is neither
 * affordable nor useful, so the tool takes a query and answers with a
 * bounded, ranked projection.
 *
 * 🔴 The projection is a PRIVACY BOUNDARY, not a formatting convenience.
 * Everything here leaves the machine (it goes into DeepSeek's request),
 * so two catalog fields are indexed but NEVER emitted:
 *   - `source_path` — an absolute local path (`/Users/<name>/.omicos/...`)
 *   - `use_when` / `instructions_summary` — the verbatim routing text the
 *     A2A surface is required to keep off the wire
 * Indexing them is the point: `summary` and `use_when` are Chinese on
 * 238/269 and 216/269 live entries respectively, so a Chinese query finds
 * the right skill through them while only the English `description` is
 * actually returned.
 */
import { HttpCoreTransport, getAgentCatalog, getSkillCatalog } from '@omicverse/omicos-client'
import type { AgentEntry, SkillEntry } from '@omicverse/omicos-protocol'

/** Plan gate ordering, weakest first. An unknown tier sorts as unrestricted. */
const TIER_RANK: Record<string, number> = { community: 0, free: 0, plus: 1, pro: 2, lab: 3, ent: 4 }

function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0
}

/** One projected, model-safe catalog hit. */
export interface CapabilityHit {
  kind: 'skill' | 'agent'
  id: string
  title: string
  /** Truncated English description — the only prose that leaves the machine. */
  description: string
  tier: string
  category: string
  /** Present only when the plan is known AND verified: this needs a higher plan than the user has. */
  locked?: boolean
}

export interface CategoryCount {
  category: string
  skills: number
  agents: number
}

export interface CapabilitySearchResult {
  query: string
  indexed: { skills: number; agents: number }
  /** The user's plan code, when the kernel has verified one. */
  plan?: string
  results: CapabilityHit[]
  /** Only for an empty query: the shape of the catalog instead of a ranked list. */
  categories?: CategoryCount[]
}

interface Term {
  text: string
  /** Whole words / whole CJK runs. Fragments (CJK bigrams) are secondary and score at half weight. */
  primary: boolean
  /** For a fragment: the primary term it was cut from. Used to drop fragments once the whole run matches. */
  parent?: string
}

const CJK = /[㐀-鿿豈-﫿]+/g
const LATIN = /[a-z0-9][a-z0-9+._-]*/g

/**
 * Query -> match terms. Latin splits on words; CJK has no spaces, so a run
 * contributes itself plus its bigrams — "空间转录组" should still hit an
 * entry that only says "空间转录".
 *
 * The bigrams are a FALLBACK, not a parallel signal: `searchCatalog` drops
 * them as soon as the whole run matches something. Live evidence for why —
 * "富集分析" decomposes to 富集/集分/分析, and 分析 ("analysis") occurs in
 * nearly every entry, so scoring the fragments alongside the run turned a
 * precise query into a popularity contest.
 */
export function tokenize(query: string): Term[] {
  const lower = query.toLowerCase()
  const terms: Term[] = []
  const seen = new Set<string>()
  const add = (text: string, primary: boolean, parent?: string): void => {
    if (text.length === 0 || seen.has(text)) return
    seen.add(text)
    terms.push(parent === undefined ? { text, primary } : { text, primary, parent })
  }
  for (const word of lower.match(LATIN) ?? []) {
    if (word.length >= 2) add(word, true)
  }
  for (const run of lower.match(CJK) ?? []) {
    add(run, true)
    if (run.length > 2) {
      for (let i = 0; i + 2 <= run.length; i += 1) add(run.slice(i, i + 2), false, run)
    }
  }
  return terms
}

/** Weighted haystacks of one entry. `body` is the indexed-but-not-emitted half. */
interface Indexed {
  hit: CapabilityHit
  order: number
  name: string
  category: string
  body: string
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf(' '))
  return `${(stop > max * 0.6 ? cut.slice(0, stop) : cut).trim()}…`
}

const DESCRIPTION_CHARS = 220

function indexSkill(s: SkillEntry): Indexed {
  return {
    hit: {
      kind: 'skill',
      id: s.id,
      title: s.title || s.id,
      description: truncate(s.description || s.summary || '', DESCRIPTION_CHARS),
      tier: s.tier,
      category: s.category,
    },
    order: s.category_order ?? 0,
    name: `${s.id} ${s.title}`.toLowerCase(),
    category: (s.category ?? '').toLowerCase(),
    // 🔴 summary + use_when make Chinese queries work; neither is emitted.
    body: `${s.description} ${s.summary} ${s.use_when}`.toLowerCase(),
  }
}

function indexAgent(a: AgentEntry): Indexed {
  return {
    hit: {
      kind: 'agent',
      id: a.id,
      title: a.name || a.id,
      description: truncate(a.description || a.summary || '', DESCRIPTION_CHARS),
      tier: a.tier,
      category: a.category,
    },
    order: a.category_order ?? 0,
    name: `${a.id} ${a.name}`.toLowerCase(),
    category: (a.category ?? '').toLowerCase(),
    // 🔴 The same three fields a skill is indexed on, and no more. Agents
    // also carry `instructions_summary`, `example_prompts` and a skill
    // list; indexing those made every broad agent ("GEO Everything") the
    // top hit for every query, because a document that mentions more
    // things matches more queries. Comparable entries need comparable
    // haystacks.
    body: `${a.description} ${a.summary} ${a.use_when}`.toLowerCase(),
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Does the term appear at all? Used for document frequency. */
function present(entry: Indexed, text: string): boolean {
  return entry.name.includes(text) || entry.category.includes(text) || entry.body.includes(text)
}

const BM25_K1 = 1.2
const BM25_B = 0.6

/**
 * Saturating term frequency with length normalization (BM25's tf term).
 *
 * 🔴 This is what separates "this skill IS differential expression" from
 * "this agent mentions it in passing" — and the reason plain presence
 * scoring was not enough: on the live catalog a Chinese query left dozens
 * of entries tied on presence, and the tiebreak (category_order) then
 * silently handed every such query to the same broad data-acquisition
 * agents.
 */
function saturatedTf(count: number, length: number, avgLength: number): number {
  if (count === 0) return 0
  return (count * (BM25_K1 + 1)) / (count + BM25_K1 * (1 - BM25_B + (BM25_B * length) / Math.max(1, avgLength)))
}

interface WeightedTerm extends Term {
  /** Rarity weight. A term in almost every entry ("analysis", "分析", "cell") contributes almost nothing. */
  idf: number
}

/**
 * Rarity weighting over THIS catalog, plus the fragment-fallback rule.
 *
 * Both exist because of what the live 269-skill catalog does to a naive
 * scorer: domain filler ("analysis", "single-cell", "数据") appears
 * everywhere, so a query's least meaningful word decided the ranking. IDF
 * is measured against the catalog in hand rather than a fixed stopword
 * list — the filler differs per domain, and a hardcoded list would rot.
 */
function weighTerms(indexed: Indexed[], terms: Term[]): WeightedTerm[] {
  const n = Math.max(1, indexed.length)
  const df = new Map<string, number>()
  for (const term of terms) {
    df.set(term.text, indexed.reduce((acc, entry) => acc + (present(entry, term.text) ? 1 : 0), 0))
  }
  return terms
    .filter((t) => (df.get(t.text) ?? 0) > 0)
    .map((t) => ({ ...t, idf: Math.max(0.05, Math.log(n / (1 + (df.get(t.text) ?? 0)))) }))
}

/**
 * A term's contribution: rarity (idf) x how central it is to the entry
 * (saturated tf over the body, flat bonuses for title/category, which are
 * short enough that frequency there is meaningless). A full-coverage
 * bonus then favours entries matching the WHOLE query.
 */
function score(entry: Indexed, terms: WeightedTerm[], avgLength: number): number {
  let total = 0
  let primaryHits = 0
  let primaryTerms = 0
  for (const term of terms) {
    if (term.primary) primaryTerms += 1
    let weight = saturatedTf(occurrences(entry.body, term.text), entry.body.length, avgLength)
    if (entry.name.includes(term.text)) weight += 3
    else if (entry.category.includes(term.text)) weight += 2
    if (weight > 0) {
      total += weight * term.idf * (term.primary ? 1 : 0.5)
      if (term.primary) primaryHits += 1
    }
  }
  if (primaryTerms > 1 && primaryHits === primaryTerms) total *= 1.5
  return total
}

export const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

export interface Catalog {
  skills: SkillEntry[]
  agents: AgentEntry[]
}

/**
 * Rank the catalog against `query`. An empty query is answered with the
 * category digest instead of an arbitrary top-N — "what can omicos do"
 * deserves the shape of the catalog, not eight random skills.
 */
export function searchCatalog(
  catalog: Catalog,
  query: string,
  opts: { limit?: number; plan?: string } = {},
): CapabilitySearchResult {
  const indexed = [...catalog.skills.map(indexSkill), ...catalog.agents.map(indexAgent)]
  const result: CapabilitySearchResult = {
    query,
    indexed: { skills: catalog.skills.length, agents: catalog.agents.length },
    ...(opts.plan === undefined ? {} : { plan: opts.plan }),
    results: [],
  }

  const annotate = (hit: CapabilityHit): CapabilityHit =>
    opts.plan !== undefined && tierRank(hit.tier) > tierRank(opts.plan) ? { ...hit, locked: true } : hit

  const terms = tokenize(query)
  if (terms.length === 0) {
    const byCategory = new Map<string, CategoryCount>()
    for (const entry of indexed) {
      const key = entry.hit.category || 'other'
      const row = byCategory.get(key) ?? { category: key, skills: 0, agents: 0 }
      if (entry.hit.kind === 'skill') row.skills += 1
      else row.agents += 1
      byCategory.set(key, row)
    }
    result.categories = [...byCategory.values()].sort((a, b) => b.skills + b.agents - (a.skills + a.agents))
    return result
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT))
  const weighted = weighTerms(indexed, terms)
  const avgLength = indexed.reduce((acc, e) => acc + e.body.length, 0) / Math.max(1, indexed.length)
  result.results = indexed
    .map((entry) => ({ entry, s: score(entry, weighted, avgLength) }))
    .filter((r) => r.s > 0)
    // Ties break toward the MORE SPECIFIC entry (shorter body), never
    // toward catalog display order — `category_order` is a UI sort key,
    // and using it here handed every tied query to the same categories.
    .sort((a, b) => b.s - a.s || a.entry.body.length - b.entry.body.length || a.entry.hit.id.localeCompare(b.entry.hit.id))
    .slice(0, limit)
    .map((r) => annotate(r.entry.hit))
  return result
}

/**
 * Catalog fetcher with a TTL cache. The catalog only changes on a skill
 * sync or a restart, and it is 272 KB — re-fetching per tool call would
 * be pure waste. Failures are not cached.
 */
export class CapabilityIndex {
  private cached: { at: number; catalog: Catalog } | undefined
  private inflight: Promise<Catalog> | undefined

  constructor(private readonly ttlMs = 5 * 60_000) {}

  async load(baseUrl: string): Promise<Catalog> {
    const now = Date.now()
    if (this.cached !== undefined && now - this.cached.at < this.ttlMs) return this.cached.catalog
    if (this.inflight !== undefined) return this.inflight
    const transport = new HttpCoreTransport(baseUrl)
    this.inflight = (async () => {
      // Agents are the smaller, less critical half — a failure there must
      // not cost the caller the skills.
      const [skills, agents] = await Promise.all([
        getSkillCatalog(transport).then((r) => r.skills ?? []),
        getAgentCatalog(transport).then(
          (r) => r.agents ?? [],
          () => [] as AgentEntry[],
        ),
      ])
      const catalog: Catalog = { skills, agents }
      this.cached = { at: Date.now(), catalog }
      return catalog
    })()
    try {
      return await this.inflight
    } finally {
      this.inflight = undefined
    }
  }
}
