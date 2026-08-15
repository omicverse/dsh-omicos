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
import { KernelManager } from './kernel.js'
import { OmicosRunner } from './runner.js'
import { registerOmicosCommands } from './commands.js'
import { registerOmicosTools } from './tools.js'
import { Schema, type Context } from './dsh-compat.js'

export const name = 'omicos'

/** Tools is the plugin's whole purpose; jobs/commands/attachments are optional (`ctx.get`) enhancements. */
export const inject = ['tools']

export interface Config {
  /** Workspace directory the omicos kernel binds to; empty = the dsh host's cwd. */
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
  const kernel = new KernelManager({
    workspace: config.workspace || process.cwd(),
    autoStart: config.autoStart,
    npmRegistry: config.npmRegistry || undefined,
    upstreamBaseUrl: config.upstreamBaseUrl,
  })
  const runner = new OmicosRunner(kernel)

  ctx.effect(function* () {
    // LIFO: yielded first -> disposed last (after every registration is gone).
    yield () => kernel.dispose()
    for (const dispose of registerOmicosTools(ctx, { kernel, runner, maxAttachmentBytes: config.maxAttachmentBytes })) {
      yield dispose
    }
    for (const dispose of registerOmicosCommands(ctx, {
      kernel,
      upstreamBaseUrl: config.upstreamBaseUrl,
      authMethod: config.authMethod,
    })) {
      yield dispose
    }
  }, 'omicos: kernel + tools + commands')
}
