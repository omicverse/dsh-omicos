/**
 * `@omicverse/dsh-omicos` — OmicOS as a deepseek-harness plugin, Mode A
 * (DSH-PLUGIN.md §3): the dsh/DeepSeek agent keeps the wheel; omicos is a
 * capability (tools + background jobs + login commands). Host-only: no
 * browser bundle, stock tool cards render the results (figures ride in as
 * ImageBlocks).
 *
 * Entry-point shape is the VERIFIED loader contract: named exports
 * `name` / `inject` / `Config` / `apply(ctx, config)`, NO default export
 * (`unwrapExports` would take the default INSTEAD of the namespace).
 *
 * Teardown is ONE generator effect: disposers run LIFO, so yielding the
 * kernel-stop first and the registrations after means unload unregisters
 * tools/commands BEFORE SIGTERMing a self-spawned core (D1 — parallel
 * async disposers would race those).
 */
import { AccountService } from './account.js'
import { OmicosPool } from './pool.js'
import { registerOmicosCommands } from './commands.js'
import { registerOmicosRoutes } from './routes.js'
import { registerOmicosTools } from './tools.js'
import { Schema, type Context } from './dsh-compat.js'

export const name = 'omicos'

/** Tools is the plugin's whole purpose; jobs/commands/attachments are optional (`ctx.get`) enhancements. */
export const inject = ['tools']

export interface Config {
  /** Explicit workspace override; empty = follow each dsh session's own workspace (`session.header.cwd`). */
  workspace: string
  /** Spawn a local kernel via `npx @omicverse/omicos` when none is attachable. */
  autoStart: boolean
  /** Cloud auth/account base URL (login channels + the spawned kernel's --upstream-base-url). */
  upstreamBaseUrl: string
  /** npm registry override for the kernel spawn (mainland-mirror knob); empty = system default. */
  npmRegistry: string
  /** Default channel for a bare /omicos-login. */
  authMethod: 'device-code' | 'wechat-qr'
  /** Figures larger than this stay path-only instead of entering dsh's attachment store. */
  maxAttachmentBytes: number
}

export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string().default(''),
  autoStart: Schema.boolean().default(true),
  upstreamBaseUrl: Schema.string().default('https://auth.omicos.cn'),
  npmRegistry: Schema.string().default(''),
  authMethod: Schema.union(['device-code', 'wechat-qr'] as const).default('device-code'),
  maxAttachmentBytes: Schema.number().min(1).default(4 * 1024 * 1024),
})

export function apply(ctx: Context, config: Config): void {
  const pool = new OmicosPool({
    autoStart: config.autoStart,
    npmRegistry: config.npmRegistry || undefined,
    upstreamBaseUrl: config.upstreamBaseUrl,
  })
  const account = new AccountService(pool, config.workspace, config.upstreamBaseUrl)

  ctx.effect(function* () {
    // LIFO: yielded first -> disposed last (after every tool is unregistered).
    yield () => pool.dispose()
    for (const dispose of registerOmicosTools(ctx, {
      pool,
      configWorkspace: config.workspace,
      maxAttachmentBytes: config.maxAttachmentBytes,
    })) {
      yield dispose
    }
  }, 'omicos: kernel pool + tools')

  // commands/webServer are OPTIONAL services that may activate after this
  // plugin (found live: webServer was still pending when apply() ran and a
  // plain ctx.get() silently skipped route registration). ctx.inject defers
  // the callback until the service exists; its registrations unwind with
  // the injected scope.
  ctx.inject(['commands'], (sub) => {
    sub.effect(function* () {
      for (const dispose of registerOmicosCommands(sub, {
        pool,
        account,
        configWorkspace: config.workspace,
        upstreamBaseUrl: config.upstreamBaseUrl,
        authMethod: config.authMethod,
      })) {
        yield dispose
      }
    }, 'omicos: commands')
  })

  ctx.inject(['webServer'], (sub) => {
    sub.effect(function* () {
      for (const dispose of registerOmicosRoutes(sub, { account })) {
        yield dispose
      }
    }, 'omicos: /omicos routes')
  })
}
