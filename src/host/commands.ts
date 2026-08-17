/**
 * Human-facing slash commands (DSH-PLUGIN.md §6). Command names use
 * hyphens — the registry's verified constraint is `/^[a-z][a-z0-9_-]*$/`,
 * so the design doc's `omicos:login` spelling is not registrable.
 *
 * A handler returns exactly one `CommandResult`, so `/omicos-login`
 * answers immediately with the pairing code / QR link and the approval
 * poll finishes in the background; `/omicos-status` reports the outcome.
 */
import { OmicosHttpError } from '@omicverse/omicos-client'
import { loginStatus } from './auth.js'
import { ACCOUNT_URL, LoginBusyError, SUBSCRIBE_URL, type AccountService } from './account.js'
import type { OmicosPool } from './pool.js'
import type { CommandResult, Context } from './dsh-compat.js'

export interface CommandDeps {
  pool: OmicosPool
  account: AccountService
  /** Explicit `config.workspace` override; empty = commands use the host cwd's entry. */
  configWorkspace: string
  upstreamBaseUrl: string
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

  const { account } = deps
  const disposers: Array<() => void> = []

  disposers.push(
    commands.register({
      name: 'omicos-login',
      description: 'Sign in to OmicOS (browser device-code pairing; sign in there with phone or email)',
      handler: async () => {
        try {
          const begun = await account.beginLogin()
          return ok(begun.message)
        } catch (err) {
          if (err instanceof LoginBusyError) return fail('已有一个登录流程在等待批准，先运行 /omicos-status 查看，或等它完成。')
          return fail(`无法开始登录：${errText(err)}`)
        }
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-help',
      description: 'What this plugin adds: tools, commands, and where to look',
      handler: () =>
        ok(
          [
            'OmicOS —— 在 dsh 里跑生信分析。以下工具由智能体自动调用，你只要正常说话：',
            '  • omicos_analyze —— 跑分析（持久 Python 内核，adata 等状态跨轮累积；长任务可转后台）',
            '  • omicos_capabilities —— 检索本机已装的技能/智能体目录',
            '  • omicos_list_variables / omicos_query_variable —— 直读内核，看有什么数据、处理到哪一步',
            '  • omicos_list_generated_files —— 本会话产出的图与文件',
            '',
            '所以「有哪些能力」「adata 现在什么状态」这类问题直接问智能体即可，不必记命令。',
            '需要你亲自做的（智能体做不了的）才是命令：',
            '  /omicos-login   登录（浏览器配对码，手机号或邮箱）',
            '  /omicos-status  内核与登录状态',
            '  /omicos-account 套餐、有效期、订阅与管理链接',
            '  /omicos-logout  退出本机内核的登录',
            '  /omicos-stop-kernel  停掉本插件自己启动的内核（外部内核不碰）',
            '',
            '上方的 OmicOS 标签页里有同样的信息，外加内核变量一览与能力检索框。',
            '',
            '可选：装上 dsh-better-sidebar，本插件会多注册一个「OmicOS 产物」侧栏页，',
            '分析产出的图与文件可以在侧边栏里直接翻看（不装也不影响任何功能）：',
            '  dsh plugin --profile web add dsh-better-sidebar',
          ].join('\n'),
        ),
    }),
  )

  disposers.push(
    commands.register({
      name: 'omicos-status',
      description: 'OmicOS kernel + sign-in status',
      handler: async () => {
        const lines: string[] = []
        if (account.loginPending) lines.push('登录：等待批准中…')
        else if (account.loginOutcome) lines.push(`登录：${account.loginOutcome}`)
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
          const snap = await account.snapshot()
          if (!snap.logged_in) {
            lines.push('未登录。运行 /omicos-login（浏览器配对码；在浏览器用手机号或邮箱登录）')
            lines.push(`注册/登录后即可试用，订阅购买：${snap.subscribe_url}`)
            return ok(lines.join('\n'))
          }
          lines.push(`账号：${snap.email || snap.user_id}（${snap.server}）`)
          if (snap.plan) {
            lines.push(`套餐：${snap.plan.name}`)
            if (!snap.plan.verified) lines.push('（内核正在向服务器确认订阅，稍后再运行一次本命令即可看到真实档位）')
            if (typeof snap.plan.token_exp === 'number') {
              lines.push(`凭证有效期至：${new Date(snap.plan.token_exp * 1000).toLocaleString('zh-CN')}${snap.plan.renewing ? '（自动续期中）' : ''}`)
            }
            if (snap.plan.session_expired) lines.push('⚠️ 登录态已过期：请退出后重新登录（/omicos-logout → /omicos-login）')
          } else {
            lines.push('套餐：查询失败（内核未就绪？）')
          }
          lines.push(`订阅购买 / 续订：${snap.subscribe_url}`)
          lines.push(`账号与订阅管理：${snap.account_url}`)
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
          await account.logout()
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
