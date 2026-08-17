/**
 * The OmicOS tab body — the plugin's console, not just an account card.
 *
 * Four panes, all fed by the host half's same-origin `/omicos/*` routes:
 * account + sign-in, the kernels this plugin is attached to, what is
 * currently bound in the kernel, and a search over the installed
 * capability catalog. The last one is deliberately here rather than in a
 * command: a human asking "what can this thing do" wants to browse, and
 * adding `/omicos-<verb>` commands for things the agent already does
 * better is how a plugin ends up with twenty commands nobody remembers.
 *
 * Money never lives here — checkout and management open the production
 * SPA in the user's real browser (storage partitioning would blind an
 * iframe to their login state, and WeChat's pages are anti-embedding —
 * verified constraints, DSH-PLUGIN.md §6/§7).
 *
 * Flat dark styling via inline tokens; no glassmorphism.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface AccountPlan {
  code: string
  name: string
  token_exp?: number
  renewing: boolean
  session_expired: boolean
  /** False while the kernel has not verified a plan token yet (momentary post-login state). */
  verified: boolean
}

interface AccountSnapshot {
  logged_in: boolean
  email?: string
  user_id?: string
  server?: string
  plan?: AccountPlan
  login_pending: boolean
  login_outcome?: string
  subscribe_url: string
  account_url: string
}

interface LoginStart {
  message: string
  verification_uri: string
  user_code: string
}

interface KernelInfo {
  workspace: string
  base_url?: string
  spawned: boolean
  version?: string
}

interface KernelVar {
  name: string
  type: string
  shape: string | null
  size_bytes: number
}

interface CapabilityHit {
  kind: 'skill' | 'agent'
  id: string
  title: string
  description: string
  tier: string
  category: string
  locked?: boolean
}

interface CapabilityResult {
  query: string
  indexed: { skills: number; agents: number }
  results: CapabilityHit[]
  categories?: Array<{ category: string; skills: number; agents: number }>
}

const S = {
  page: { padding: '24px', maxWidth: 1100, margin: '0 auto', color: 'var(--ds-fg, #e6e6e6)', fontSize: 14, lineHeight: 1.7 } as const,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' } as const,
  card: { background: 'var(--ds-bg-raised, #1b1d22)', border: '1px solid var(--ds-border, #2a2d34)', borderRadius: 8, padding: '16px 20px', marginBottom: 16 } as const,
  cardTight: { background: 'var(--ds-bg-raised, #1b1d22)', border: '1px solid var(--ds-border, #2a2d34)', borderRadius: 8, padding: '16px 20px', marginBottom: 0 } as const,
  h: { fontSize: 13, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } as const,
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } as const,
  dim: { opacity: 0.6 } as const,
  badge: { display: 'inline-block', padding: '1px 10px', borderRadius: 4, background: '#2b4a2f', color: '#9be29f', fontWeight: 600 } as const,
  badgePending: { display: 'inline-block', padding: '1px 10px', borderRadius: 4, background: '#2a2d34', color: '#9aa3ad', fontWeight: 600 } as const,
  tag: { display: 'inline-block', padding: '0 7px', borderRadius: 4, background: '#22252b', color: '#9aa3ad', fontSize: 11, fontWeight: 600, letterSpacing: '0.03em' } as const,
  tagLocked: { display: 'inline-block', padding: '0 7px', borderRadius: 4, background: '#3a3323', color: '#e2c07f', fontSize: 11, fontWeight: 600 } as const,
  warn: { color: '#e2a75f' } as const,
  btnRow: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' } as const,
  btn: { padding: '7px 16px', borderRadius: 6, border: '1px solid var(--ds-border, #2a2d34)', background: 'var(--ds-bg, #14161a)', color: 'inherit', cursor: 'pointer', fontSize: 13 } as const,
  btnPrimary: { padding: '7px 16px', borderRadius: 6, border: '1px solid #3d6b45', background: '#2b4a2f', color: '#c9f0cc', cursor: 'pointer', fontSize: 13, fontWeight: 600 } as const,
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 18, fontWeight: 700, letterSpacing: '0.1em' } as const,
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 } as const,
  err: { color: '#e0705f' } as const,
  input: { flex: 1, minWidth: 0, padding: '7px 12px', borderRadius: 6, border: '1px solid var(--ds-border, #2a2d34)', background: 'var(--ds-bg, #14161a)', color: 'inherit', fontSize: 13 } as const,
  hit: { padding: '8px 0', borderTop: '1px solid var(--ds-border, #2a2d34)' } as const,
  scroll: { maxHeight: 320, overflowY: 'auto' } as const,
} as const

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Last path segment — a full workspace path is unreadable in a narrow pane. */
function shortWorkspace(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length === 0 ? path : parts[parts.length - 1]!
}

function KernelPane(): JSX.Element {
  const [kernels, setKernels] = useState<KernelInfo[] | undefined>()
  const [vars, setVars] = useState<Record<string, KernelVar[]>>({})

  const refresh = useCallback(async () => {
    try {
      const body = await getJson<{ kernels: KernelInfo[] }>('/omicos/kernel')
      setKernels(body.kernels)
      const loaded: Record<string, KernelVar[]> = {}
      for (const k of body.kernels) {
        try {
          const v = await getJson<{ vars: KernelVar[] }>(`/omicos/vars?workspace=${encodeURIComponent(k.workspace)}`)
          loaded[k.workspace] = v.vars
        } catch {
          // a kernel that will not answer still deserves its status row
        }
      }
      setVars(loaded)
    } catch {
      setKernels([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <div style={S.cardTight}>
      <div style={S.h}>内核</div>
      {kernels === undefined && <div style={S.dim}>加载中…</div>}
      {kernels?.length === 0 && (
        <div style={S.dim}>
          还没有连接内核。第一次调用 omicos 工具（或运行 <code>/omicos-login</code>）时会自动挂载已在运行的内核，
          没有就用随插件装好的二进制启动一个。
        </div>
      )}
      {kernels?.map((k) => (
        <div key={k.workspace} style={{ marginBottom: 12 }}>
          <div style={S.row}>
            <span style={S.dim}>工作区</span>
            <span title={k.workspace}>{shortWorkspace(k.workspace)}</span>
          </div>
          <div style={S.row}>
            <span style={S.dim}>地址</span>
            <span style={S.mono}>{k.base_url}</span>
          </div>
          <div style={S.row}>
            <span style={S.dim}>版本</span>
            <span style={S.mono}>{k.version ?? '—'}</span>
          </div>
          <div style={S.row}>
            <span style={S.dim}>来源</span>
            <span>{k.spawned ? '本插件启动' : '挂载到已运行实例'}</span>
          </div>
          <div style={{ ...S.h, marginTop: 10 }}>内核变量</div>
          {(vars[k.workspace] ?? []).length === 0 ? (
            <div style={S.dim}>暂无数据对象——跑一次分析后，这里会列出 adata 之类的变量。</div>
          ) : (
            <div style={S.scroll}>
              {(vars[k.workspace] ?? []).map((v) => (
                <div key={v.name} style={S.row}>
                  <span style={S.mono}>{v.name}</span>
                  <span style={S.dim}>
                    {v.type}
                    {v.shape ? ` ${v.shape}` : ''} · {humanBytes(v.size_bytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={S.btnRow}>
        <button style={S.btn} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
    </div>
  )
}

function CapabilityPane(): JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<CapabilityResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const search = useCallback(async (q: string) => {
    setBusy(true)
    try {
      const body = await getJson<CapabilityResult>(`/omicos/capabilities?q=${encodeURIComponent(q)}&limit=12`)
      setResult(body)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  // Overview on mount: an empty query answers with the catalog's shape.
  useEffect(() => {
    void search('')
  }, [search])

  return (
    <div style={S.cardTight}>
      <div style={S.h}>能力检索</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={S.input}
          value={query}
          placeholder="例如 spatial deconvolution、通路富集"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query)
          }}
        />
        <button style={S.btn} disabled={busy} onClick={() => void search(query)}>
          搜索
        </button>
      </div>
      {error !== undefined && <div style={{ ...S.err, marginTop: 8 }}>{error}</div>}
      {result !== undefined && (
        <>
          <div style={{ ...S.dim, fontSize: 12, marginTop: 8 }}>
            本机已装 {result.indexed.skills} 个技能 · {result.indexed.agents} 个智能体
            {result.results.length > 0 ? `，匹配前 ${result.results.length} 条` : ''}
          </div>
          {result.categories !== undefined && (
            <div style={{ ...S.scroll, marginTop: 4 }}>
              {result.categories.map((c) => (
                <div key={c.category} style={S.row}>
                  <span>{c.category}</span>
                  <span style={S.dim}>
                    {c.skills} 技能 / {c.agents} 智能体
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={S.scroll}>
            {result.results.map((h) => (
              <div key={`${h.kind}:${h.id}`} style={S.hit}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={S.tag}>{h.kind === 'skill' ? '技能' : '智能体'}</span>
                  <b>{h.title}</b>
                  {h.locked === true && <span style={S.tagLocked}>需 {h.tier}</span>}
                </div>
                <div style={{ ...S.dim, fontSize: 12 }}>{h.description}</div>
              </div>
            ))}
          </div>
          {result.results.length === 0 && result.categories === undefined && (
            <div style={S.dim}>没有匹配项。换个更宽的关键词，或清空搜索框看分类总览。</div>
          )}
        </>
      )}
      <div style={{ ...S.dim, fontSize: 12, marginTop: 10 }}>
        这里只是目录——不用按名字调用，直接在对话里描述任务，OmicOS 会自己路由。
      </div>
    </div>
  )
}

export function AccountTab(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AccountSnapshot | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [login, setLogin] = useState<LoginStart | undefined>()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const snap = await getJson<AccountSnapshot>('/omicos/account')
      if (!alive.current) return
      setSnapshot(snap)
      setError(undefined)
      if (!snap.login_pending) setLogin(undefined)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  // Auto-retry until the first successful load: the host half may still be
  // starting (or was restarted) when the tab mounts — a one-shot fetch
  // stranded the tab on "Failed to fetch" forever.
  useEffect(() => {
    if (snapshot !== undefined) return
    const timer = setInterval(() => {
      void refresh()
    }, 4000)
    return () => clearInterval(timer)
  }, [snapshot, refresh])

  // While a login awaits approval, poll so the tab flips to signed-in on its own.
  useEffect(() => {
    if (!snapshot?.login_pending && login === undefined) return
    const timer = setInterval(() => {
      void refresh()
    }, 2500)
    return () => clearInterval(timer)
  }, [snapshot?.login_pending, login, refresh])

  // 🔴 Keep the plan fresh. The kernel resolves its plan token ASYNC — right
  // after login it still reports core's unverified default, and it renews in
  // the background afterwards. Reading once and freezing showed a signed-in
  // Lab account as "community" indefinitely (observed live). Fast cadence
  // until the plan is verified, slow one after.
  useEffect(() => {
    if (snapshot === undefined || !snapshot.logged_in) return
    const settled = snapshot.plan?.verified === true
    const timer = setInterval(() => void refresh(), settled ? 60_000 : 3000)
    return () => clearInterval(timer)
  }, [snapshot, refresh])

  const startLogin = useCallback(
    async () => {
      setBusy(true)
      try {
        const started = await postJson<LoginStart>('/omicos/login/start')
        if (!alive.current) return
        setLogin(started)
        setError(undefined)
        void refresh()
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [refresh],
  )

  const doLogout = useCallback(async () => {
    setBusy(true)
    try {
      await postJson('/omicos/logout')
      setLogin(undefined)
      await refresh()
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  if (snapshot === undefined) {
    return (
      <div style={S.page}>
        {error !== undefined ? (
          <div style={S.card}>
            <div style={S.err}>加载失败：{error}</div>
            <div style={S.dim}>每 4 秒自动重试中（omicos 宿主可能正在启动）…</div>
            <div style={S.btnRow}>
              <button style={S.btn} onClick={() => void refresh()}>
                立即重新加载
              </button>
            </div>
          </div>
        ) : (
          '加载中…'
        )}
      </div>
    )
  }

  return (
    <div style={S.page}>
      {error !== undefined && <div style={{ ...S.card, ...S.err }}>{error}</div>}

      {snapshot.logged_in ? (
        <div style={S.card}>
          <div style={S.h}>账号</div>
          <div style={S.row}>
            <span style={S.dim}>身份</span>
            <span>{snapshot.email || snapshot.user_id}</span>
          </div>
          <div style={S.row}>
            <span style={S.dim}>套餐</span>
            <span style={snapshot.plan?.verified === false ? S.badgePending : S.badge}>
              {snapshot.plan?.name ?? '加载中…'}
            </span>
          </div>
          {typeof snapshot.plan?.token_exp === 'number' && (
            <div style={S.row}>
              <span style={S.dim}>凭证有效期</span>
              <span>
                {new Date(snapshot.plan.token_exp * 1000).toLocaleString('zh-CN')}
                {snapshot.plan.renewing ? '（自动续期中）' : ''}
              </span>
            </div>
          )}
          {snapshot.plan?.verified === false && (
            <div style={S.dim}>内核正在向服务器确认订阅（刚登录时需要几秒）——确认后这里会自动更新。</div>
          )}
          {snapshot.plan?.session_expired && (
            <div style={S.warn}>⚠️ 登录态已过期，请退出后重新登录。</div>
          )}
          <div style={S.btnRow}>
            <button style={S.btnPrimary} onClick={() => window.open(snapshot.subscribe_url, '_blank', 'noopener')}>
              订阅购买 / 续订
            </button>
            <button style={S.btn} onClick={() => window.open(snapshot.account_url, '_blank', 'noopener')}>
              账号与订阅管理
            </button>
            <button style={S.btn} disabled={busy} onClick={() => void refresh()}>
              刷新
            </button>
            <button style={S.btn} disabled={busy} onClick={() => void doLogout()}>
              退出登录
            </button>
          </div>
        </div>
      ) : (
        <div style={S.card}>
          <div style={S.h}>登录 OmicOS</div>
          {login === undefined && !snapshot.login_pending && (
            <>
              <div style={S.dim}>
                登录后即可在对话里使用 omicos 生信分析工具；新用户注册即可试用。
                点下面的按钮会给出一个配对码，在浏览器用<b>手机号或邮箱</b>登录并批准即可
                —— 插件不经手你的密码或验证码。
              </div>
              <div style={S.btnRow}>
                <button style={S.btnPrimary} disabled={busy} onClick={() => void startLogin()}>
                  开始登录
                </button>
              </div>
            </>
          )}
          {login !== undefined && (
            <>
              <div>
                在浏览器打开{' '}
                <a href={login.verification_uri} target="_blank" rel="noopener noreferrer">
                  {login.verification_uri}
                </a>{' '}
                ，用手机号或邮箱登录后输入配对码：
              </div>
              <div style={S.code}>{login.user_code}</div>
              <div style={S.dim}>批准后此页会自动刷新为已登录。</div>
            </>
          )}
          {login === undefined && snapshot.login_pending && <div style={S.dim}>已有一个登录流程在等待批准…</div>}
          {snapshot.login_outcome !== undefined && <div style={{ marginTop: 8 }}>{snapshot.login_outcome}</div>}
          <div style={{ ...S.btnRow, marginTop: 16 }}>
            <button style={S.btn} onClick={() => window.open(snapshot.subscribe_url, '_blank', 'noopener')}>
              查看套餐与定价
            </button>
          </div>
        </div>
      )}

      <div style={S.grid}>
        <KernelPane />
        <CapabilityPane />
      </div>

      <div style={{ ...S.dim, fontSize: 12, marginTop: 16 }}>
        购买与管理在 app.omicos.cn 完成；本插件不保存任何支付信息与登录凭据（token 由本地 omicos 内核保管）。
      </div>
    </div>
  )
}
