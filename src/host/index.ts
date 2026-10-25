import type {} from '@deepseek-ai/dsh-api-session-controller'
import { HarnessScienceChat } from './oss-chat.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { OssRuntime } from '../oss/runtime.js'
import { createOssHandler } from '../oss/http.js'
import { registerOssTools } from './oss-tools.js'
/**
 * OmicOS OSS Harness Host plugin. The default backend registers explicit
 * scientific tools and a shared Python/R runtime. Harness remains the sole
 * Agent loop. Official cloud commerce is optional and Host-owned.
 * `backend: core` retains the original delegated Core adapter for migration.
 * Every registration is lifecycle-owned; teardown waits for startup and
 * worker quiescence before releasing project ownership.
 */
import { AccountService } from './account.js'
import { ActivityStore } from './activity-store.js'
import { OmicosPool } from './pool.js'
import { registerOmicosCommands } from './commands.js'
import { registerOmicosRoutes } from './routes.js'
import { registerOmicosTools } from './tools.js'
import { Schema, type Context } from './dsh-compat.js'

export const name = 'omicos'

/** Tools is the plugin's whole purpose; jobs/commands/attachments are optional (`ctx.get`) enhancements. */
export const inject = ['tools']

export interface Config {
  backend: 'oss' | 'core'
  python: string
  rscript: string
  workerEnvNames: string[]
  stateDir: string
  /** Explicit workspace override; empty = follow each dsh session's own workspace (`session.header.cwd`). */
  workspace: string
  /** Spawn a local kernel via `npx @omicverse/omicos` when none is attachable. */
  autoStart: boolean
  /** Cloud auth/account base URL (login channels + the spawned kernel's --upstream-base-url). */
  upstreamBaseUrl: string
  /** npm registry override for the kernel spawn (mainland-mirror knob); empty = system default. */
  npmRegistry: string
  /** Reserved (v0.2 dropped the dsh-attachment figure path — images now render via /omicos/figure; key kept so existing patch configs stay valid). */
  maxAttachmentBytes: number
}

export const Config = Schema.object({
  backend: Schema.union(['oss', 'core']).default('oss'),
  python: Schema.string().default('python3'),
  rscript: Schema.string().default('Rscript'),
  workerEnvNames: Schema.array(Schema.string()).default([]),
  stateDir: Schema.string().default(''),
  workspace: Schema.string().default(''),
  autoStart: Schema.boolean().default(true),
  upstreamBaseUrl: Schema.string().default('https://auth.omicos.cn'),
  npmRegistry: Schema.string().default(''),
  maxAttachmentBytes: Schema.number().min(1).default(4 * 1024 * 1024),
})

export function apply(ctx: Context, config: Config): void {
  const runtime = OssRuntime.open({ python: config.python, rscript: config.rscript, workerEnvNames: config.workerEnvNames, stateDir: config.stateDir || undefined, cloudBase: config.upstreamBaseUrl }).then(async service => {
    try { await service.project(config.workspace || process.cwd()); return service }
    catch (error) { await service.dispose(); throw error }
  })
  // Attach rejection handling immediately; lifecycle cleanup still awaits it.
  void runtime.catch(error => console.error('OmicOS OSS startup failed:', String(error)))
  ctx.effect(function* () {
    yield async () => { await (await runtime).dispose() }
    if (config.backend !== 'core') for (const dispose of registerOssTools(ctx, runtime, config.workspace)) yield dispose
  }, 'omicos: OSS scientific service')
  ctx.inject(['webServer'], sub => {
    let handler: ReturnType<typeof createOssHandler> | undefined
    sub.effect(() => sub.webServer.register({ kind: 'prefix', path: '/omicos/oss', handler: async (req, res) => {
      handler ??= createOssHandler(await runtime)
      await handler(req, res)
    } }))
  })
  ctx.inject(['sessionController'], sub => {
    sub.effect(async function* () {
      const service = await runtime
      const chat = new HarnessScienceChat(sub.sessionController)
      service.chat = chat
      service.resolveSessionWorkspace = (sessionId, signal) => chat.workspaceForSession(sessionId, signal)
      yield () => { if (service.chat === chat) { service.chat = undefined; service.resolveSessionWorkspace = undefined } }
    }, 'omicos: Harness conversation bridge')
  })
  if (config.backend !== 'core') {
    ctx.inject(['agentPresets'], sub => {
      sub.effect(async function* () {
        yield await sub.agentPresets.register({ id: 'omicos', name: 'OmicOS Scientist', description: 'Bioinformatics research with a persistent project kernel and sourced memory.', order: 15,
          plugins: [{ id: 'omicos-scientist', name: '@omicverse/dsh-omicos/scientist' }] })
      }, 'omicos: scientist preset')
    })
    return
  }

  const pool = new OmicosPool({
    autoStart: config.autoStart,
    npmRegistry: config.npmRegistry || undefined,
    upstreamBaseUrl: config.upstreamBaseUrl,
  })
  const account = new AccountService(pool, config.workspace, config.upstreamBaseUrl)
  const activity = new ActivityStore()

  ctx.effect(function* () {
    // LIFO: yielded first -> disposed last (after every tool is unregistered).
    yield () => pool.dispose()
    for (const dispose of registerOmicosTools(ctx, {
      pool,
      activity,
      account,
      configWorkspace: config.workspace,
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
      })) {
        yield dispose
      }
    }, 'omicos: commands')
  })

  ctx.inject(['webServer'], (sub) => {
    sub.effect(function* () {
      for (const dispose of registerOmicosRoutes(sub, { account, activity, pool })) {
        yield dispose
      }
    }, 'omicos: /omicos routes')
  })
}
