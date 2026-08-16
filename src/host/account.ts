/**
 * Shared account/subscription state for BOTH human surfaces — the slash
 * commands and the browser tab's `/omicos/*` routes — so a login started
 * from either shows up in the other (one pending-login state, one outcome
 * line). dsh-free.
 *
 * The commercial loop stays on OUR domain: checkout/management are deep
 * links into the production SPA (`page` is BenchView's verified query
 * param — APP_PAGE_IDS contains 'subscription' and 'settings'). WeChat /
 * Alipay checkout is domain-whitelisted and the SPA pages already exist;
 * the plugin never renders a payment form.
 */
import { HttpCoreTransport, getPlanHealth } from '@omicverse/omicos-client'
import { ORIGIN_APP } from '@omicverse/omicos-protocol'
import { beginDeviceCodeLogin, describeUser, loginStatus, logout, type BegunLogin } from './auth.js'
import type { OmicosPool } from './pool.js'

export const SUBSCRIBE_URL = `${ORIGIN_APP}/#/bench?page=subscription`
export const ACCOUNT_URL = `${ORIGIN_APP}/#/bench?page=settings`

export const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  lab: 'Lab（实验室版）',
  ent: 'Enterprise（企业版）',
}

export interface AccountPlan {
  code: string
  name: string
  token_exp?: number
  renewing: boolean
  session_expired: boolean
}

/** JSON-safe snapshot the tab renders (also the substrate of /omicos-account's text). */
export interface AccountSnapshot {
  logged_in: boolean
  email?: string
  user_id?: string
  server?: string
  plan?: AccountPlan
  login_pending: boolean
  /** Outcome line of the last finished background login. */
  login_outcome?: string
  subscribe_url: string
  account_url: string
}

export class LoginBusyError extends Error {
  constructor() {
    super('a login flow is already awaiting approval')
    this.name = 'LoginBusyError'
  }
}

export class AccountService {
  private pending = false
  private lastOutcome: string | undefined

  constructor(
    private readonly pool: OmicosPool,
    private readonly configWorkspace: string,
    private readonly upstreamBaseUrl: string,
  ) {}

  /** cloud_login.json lives in the user-global ~/.omicos, so ONE kernel is enough to push a login through. */
  private kernel() {
    return this.pool.entry(this.configWorkspace || process.cwd()).kernel
  }

  get loginPending(): boolean {
    return this.pending
  }

  get loginOutcome(): string | undefined {
    return this.lastOutcome
  }

  /**
   * Start the device-code login; resolves fast with the pairing code, the
   * approval completes in the background. Device code is the only channel
   * (see auth.ts): the user signs in with phone or email on the SPA.
   * Throws `LoginBusyError` when one is already pending.
   */
  async beginLogin(): Promise<BegunLogin> {
    if (this.pending) throw new LoginBusyError()
    const begun = await beginDeviceCodeLogin(this.kernel(), this.upstreamBaseUrl)
    this.pending = true
    begun.done.then(
      (user) => {
        this.pending = false
        this.lastOutcome = `已登录：${describeUser(user)}（token 由本地 omicos 内核保管）`
      },
      (err: unknown) => {
        this.pending = false
        this.lastOutcome = `登录失败：${err instanceof Error ? err.message : String(err)}`
      },
    )
    return begun
  }

  async logout(): Promise<void> {
    await logout(this.kernel())
    this.lastOutcome = undefined
  }

  /** Identity + plan, folded into one JSON-safe snapshot. Kernel/plan failures degrade field-wise, never throw past identity. */
  async snapshot(): Promise<AccountSnapshot> {
    const base: AccountSnapshot = {
      logged_in: false,
      login_pending: this.pending,
      login_outcome: this.lastOutcome,
      subscribe_url: SUBSCRIBE_URL,
      account_url: ACCOUNT_URL,
    }
    const kernel = this.kernel()
    const identity = await loginStatus(kernel)
    if (!identity.logged_in) return base
    base.logged_in = true
    base.email = identity.email || undefined
    base.user_id = identity.user_id ?? undefined
    base.server = identity.server ?? undefined
    try {
      const handle = await kernel.handle()
      const plan = await getPlanHealth(new HttpCoreTransport(handle.baseUrl))
      base.plan = {
        code: plan.plan_code,
        name: PLAN_NAMES[plan.plan_code] ?? plan.plan_code,
        token_exp: typeof plan.token_exp === 'number' ? plan.token_exp : undefined,
        renewing: plan.renewing === true,
        session_expired: plan.sessionExpired,
      }
    } catch {
      // plan pane degrades; identity is still worth showing
    }
    return base
  }
}
