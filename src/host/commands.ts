/**
 * Human-facing slash commands (DSH-PLUGIN.md §6). Command names use
 * hyphens — the registry's verified constraint is `/^[a-z][a-z0-9_-]*$/`,
 * so the design doc's `omicos:login` spelling is not registrable.
 *
 * A handler returns exactly one `CommandResult`, so `/omicos-login`
 * answers immediately with the pairing code / QR link and the approval
 * poll finishes in the background; `/omicos-status` reports the outcome.
 */
import { HttpCoreTransport, OmicosHttpError, getPlanHealth } from '@omicverse/omicos-client'
import { ORIGIN_APP } from '@omicverse/omicos-protocol'
import { beginDeviceCodeLogin, beginWechatLogin, describeUser, loginStatus, logout } from './auth.js'
import type { OmicosPool } from './pool.js'
import type { CommandResult, Context } from './dsh-compat.js'

export interface CommandDeps {
  pool: OmicosPool
  /** Explicit `config.workspace` override; empty = commands use the host cwd's entry. */
  configWorkspace: string
  upstreamBaseUrl: string
  /** Default channel for a bare `/omicos-login`. */
  authMethod: 'device-code' | 'wechat-qr'
}

/** cloud_login.json lives in the user-global ~/.omicos, so ONE kernel is enough to push a login through. */
function loginKernel(deps: CommandDeps) {
  return deps.pool.entry(deps.configWorkspace || process.cwd()).kernel
}

/**
 * The commercial loop stays on OUR domain (the production SPA already has
 * the subscription/checkout/settings pages, and WeChat/Alipay checkout is
 * domain-whitelisted) — the plugin only deep-links. `page` is BenchView's
 * verified query param (APP_PAGE_IDS includes 'subscription'/'settings').
 */
const SUBSCRIBE_URL = `${ORIGIN_APP}/#/bench?page=subscription`
const ACCOUNT_URL = `${ORIGIN_APP}/#/bench?page=settings`

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  lab: 'Lab（实验室版）',
  ent: 'Enterprise（企业版）',
}

interface LoginState {
  pending: boolean
  /** Outcome line of the last finished background login, shown by `/omicos-status`. */
  lastOutcome?: string
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

function errText(err: unknown): string {
  if (err instanceof OmicosHttpError) return `HTTP ${err.status}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

/** Register the command set. Returns disposers (caller owns effect wiring). */
export function registerOmicosCommands(ctx: Context, deps: CommandDeps): Array<() => void> {
  const commands = ctx.get('commands')
  if (commands === undefined) return []

  const state: LoginState = { pending: false }

  const trackLogin = (done: Promise<{ email?: string; phone?: string; id: string }>): void => {
    state.pending = true
    done.then(
      (user) => {
        state.pending = false
        state.lastOutcome = `已登录：${describeUser(user)}（token 由本地 omicos 内核保管）`
      },
      (err: unknown) => {
        state.pending = false
        state.lastOutcome = `登录失败：${errText(err)}`
      },
    )
  }

  const disposers: Array<() => void> = []

  disposers.push(
    commands.register({
      name: 'omicos-login',
      description: 'Sign in to OmicOS (input: "wechat" or "device"; default from plugin config)',
      handler: async (invocation) => {
        if (state.pending) return fail('已有一个登录流程在等待批准，先运行 /omicos-status 查看，或等它完成。')
        const raw = invocation.rawInput.trim().toLowerCase()
        const method = raw === '' ? deps.authMethod : raw
        try {
          if (method === 'wechat' || method === 'wechat-qr') {
            const begun = await beginWechatLogin(loginKernel(deps), deps.upstreamBaseUrl)
            trackLogin(begun.done)
            return ok(begun.message)
          }
          if (method === 'device' || method === 'device-code') {
            const begun = await beginDeviceCodeLogin(loginKernel(deps), deps.upstreamBaseUrl)
            trackLogin(begun.done)
            return ok(begun.message)
          }
          return fail(`未知登录方式 "${raw}"，可用：wechat / device`)
        } catch (err) {
          return fail(`无法开始登录：${errText(err)}`)
        }
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-status',
      description: 'OmicOS kernel + sign-in status',
      handler: async () => {
        const lines: string[] = []
        if (state.pending) lines.push('登录：等待批准中…')
        else if (state.lastOutcome) lines.push(`登录：${state.lastOutcome}`)
        const entries = deps.pool.list().filter((e) => e.kernel.baseUrl !== undefined)
        if (entries.length === 0) {
          lines.push('内核：未连接（首次使用 omicos 工具时自动连接/启动）')
          return ok(lines.join('\n'))
        }
        for (const e of entries) {
          lines.push(`内核：${e.kernel.baseUrl}（工作区 ${e.workspace}，${e.kernel.isSpawned ? '由本插件启动' : '挂载到已运行实例'}）`)
        }
        try {
          const identity = await loginStatus(entries[0]!.kernel)
          lines.push(
            identity.logged_in
              ? `账号：${identity.email || identity.user_id}（${identity.server}）`
              : '账号：未登录（运行 /omicos-login）',
          )
        } catch (err) {
          lines.push(`账号：查询失败（${errText(err)}）`)
        }
        return ok(lines.join('\n'))
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-account',
      description: 'OmicOS account: plan, expiry, and links to subscribe / manage',
      handler: async () => {
        const lines: string[] = []
        try {
          const kernel = loginKernel(deps)
          const identity = await loginStatus(kernel)
          if (!identity.logged_in) {
            lines.push('未登录。运行 /omicos-login（微信扫码：/omicos-login wechat）')
            lines.push(`注册/登录后即可试用，订阅购买：${SUBSCRIBE_URL}`)
            return ok(lines.join('\n'))
          }
          lines.push(`账号：${identity.email || identity.user_id}（${identity.server}）`)
          try {
            const handle = await kernel.handle()
            const plan = await getPlanHealth(new HttpCoreTransport(handle.baseUrl))
            const planName = PLAN_NAMES[plan.plan_code] ?? plan.plan_code
            lines.push(`套餐：${planName}`)
            if (typeof plan.token_exp === 'number') {
              lines.push(`凭证有效期至：${new Date(plan.token_exp * 1000).toLocaleString('zh-CN')}${plan.renewing ? '（自动续期中）' : ''}`)
            }
            if (plan.sessionExpired) lines.push('⚠️ 登录态已过期：请退出后重新登录（/omicos-logout → /omicos-login）')
          } catch {
            lines.push('套餐：查询失败（内核未就绪？）')
          }
          lines.push(`订阅购买 / 续订：${SUBSCRIBE_URL}`)
          lines.push(`账号与订阅管理：${ACCOUNT_URL}`)
          return ok(lines.join('\n'))
        } catch (err) {
          return fail(`账号信息获取失败：${errText(err)}`)
        }
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-logout',
      description: 'Sign this machine\'s OmicOS kernel out',
      handler: async () => {
        try {
          await logout(loginKernel(deps))
          state.lastOutcome = undefined
          return ok('已退出登录（仅本机内核；云端 token 未被吊销）。')
        } catch (err) {
          return fail(`退出失败：${errText(err)}`)
        }
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-stop-kernel',
      description: 'Stop the OmicOS kernel IF this plugin spawned it (an attached kernel is never touched)',
      handler: () => {
        if (deps.pool.list().every((e) => e.kernel.baseUrl === undefined)) return ok('没有已连接的内核。')
        const stopped = deps.pool.stopSpawned()
        return stopped > 0
          ? ok(`已停止 ${stopped} 个本插件启动的内核（下次使用工具时会重新启动）；外部启动的内核未触碰。`)
          : ok('连接的内核均由外部启动（桌面 App 或终端），本插件不会停止它们；已断开挂载。')
      },
    }),
  )

  return disposers
}
