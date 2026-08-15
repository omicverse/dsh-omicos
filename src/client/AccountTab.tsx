/**
 * The OmicOS tab body: account identity + plan + login (WeChat QR /
 * device code) + commerce buttons. Money never lives here — checkout and
 * management open the production SPA in the user's real browser (storage
 * partitioning would blind an iframe to their login state, and WeChat's
 * pages are anti-embedding — verified constraints, DSH-PLUGIN.md §6/§7).
 *
 * Data comes from the host half's same-origin `/omicos/*` routes. Flat
 * dark styling via inline tokens; no glassmorphism.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface AccountPlan {
  code: string
  name: string
  token_exp?: number
  renewing: boolean
  session_expired: boolean
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
  method: 'wechat-qr' | 'device-code'
  message: string
  qr_url?: string
  verification_uri?: string
  user_code?: string
}

const S = {
  page: { padding: '24px', maxWidth: 560, margin: '0 auto', color: 'var(--ds-fg, #e6e6e6)', fontSize: 14, lineHeight: 1.7 } as const,
  card: { background: 'var(--ds-bg-raised, #1b1d22)', border: '1px solid var(--ds-border, #2a2d34)', borderRadius: 8, padding: '16px 20px', marginBottom: 16 } as const,
  h: { fontSize: 13, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } as const,
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } as const,
  dim: { opacity: 0.6 } as const,
  badge: { display: 'inline-block', padding: '1px 10px', borderRadius: 4, background: '#2b4a2f', color: '#9be29f', fontWeight: 600 } as const,
  warn: { color: '#e2a75f' } as const,
  btnRow: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' } as const,
  btn: { padding: '7px 16px', borderRadius: 6, border: '1px solid var(--ds-border, #2a2d34)', background: 'var(--ds-bg, #14161a)', color: 'inherit', cursor: 'pointer', fontSize: 13 } as const,
  btnPrimary: { padding: '7px 16px', borderRadius: 6, border: '1px solid #3d6b45', background: '#2b4a2f', color: '#c9f0cc', cursor: 'pointer', fontSize: 13, fontWeight: 600 } as const,
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 18, fontWeight: 700, letterSpacing: '0.1em' } as const,
  qr: { width: 180, height: 180, borderRadius: 6, background: '#fff', display: 'block', margin: '10px 0' } as const,
  err: { color: '#e0705f' } as const,
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

  // While a login awaits approval, poll so the tab flips to signed-in on its own.
  useEffect(() => {
    if (!snapshot?.login_pending && login === undefined) return
    const timer = setInterval(() => {
      void refresh()
    }, 2500)
    return () => clearInterval(timer)
  }, [snapshot?.login_pending, login, refresh])

  const startLogin = useCallback(
    async (method: 'wechat-qr' | 'device-code') => {
      setBusy(true)
      try {
        const started = await postJson<LoginStart>('/omicos/login/start', { method })
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
    return <div style={S.page}>{error ? <span style={S.err}>加载失败：{error}</span> : '加载中…'}</div>
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
            <span style={S.badge}>{snapshot.plan?.name ?? '未知'}</span>
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
              <div style={S.dim}>登录后即可在对话里使用 omicos 生信分析工具；新用户注册即可试用。</div>
              <div style={S.btnRow}>
                <button style={S.btnPrimary} disabled={busy} onClick={() => void startLogin('wechat-qr')}>
                  微信扫码登录
                </button>
                <button style={S.btn} disabled={busy} onClick={() => void startLogin('device-code')}>
                  浏览器配对码登录
                </button>
              </div>
            </>
          )}
          {login?.method === 'wechat-qr' && login.qr_url !== undefined && (
            <>
              <div>用微信扫码，然后在手机上确认：</div>
              {/* Own component: not bound by dsh's markdown URL allowlist. */}
              <img style={S.qr} src={login.qr_url} alt="微信登录二维码" />
              <div style={S.dim}>确认后此页会自动刷新为已登录。</div>
            </>
          )}
          {login?.method === 'device-code' && (
            <>
              <div>
                在浏览器打开{' '}
                <a href={login.verification_uri} target="_blank" rel="noopener noreferrer">
                  {login.verification_uri}
                </a>{' '}
                并输入配对码：
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

      <div style={{ ...S.dim, fontSize: 12 }}>
        购买与管理在 app.omicos.cn 完成；本插件不保存任何支付信息与登录凭据（token 由本地 omicos 内核保管）。
      </div>
    </div>
  )
}
