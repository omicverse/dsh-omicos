/**
 * 🔴 THE anti-corruption layer (DSH-PLUGIN.md §4): every `@deepseek-ai/*`
 * import in this package goes through this module and nowhere else. dsh is
 * a days-old developer preview pinned EXACTLY (0.1.0-rc.6, no `^`) — when
 * it churns, the breakage surfaces here first and the rest of the plugin
 * (and everything under `bridge.ts`/`runner.ts`/`kernel.ts`, which import
 * no dsh at all) stays untouched.
 *
 * Verified against the local clone @47f9438 (DSH-PLUGIN.md appendix facts
 * D1-D15 + this session's line-by-line re-verification):
 *  - plugin entry = named exports `name`/`inject`/`Config`/`apply(ctx, config)`
 *    (loader `unwrapExports` treats the module namespace as a Plugin.Object
 *    when there is no default export — do not add one).
 *  - tool parameter schemas are dsh-tools' OWN JSON-schema DSL
 *    (`ParameterSchemaSpec`, per-property `required: true`, objects must
 *    write `additionalProperties` explicitly) — NOT Schemastery, which is
 *    only for the plugin `Config`.
 *  - `ContentBlock`/`ImageBlock` come from `@deepseek-ai/dsh-llm`
 *    (dsh-tools does not re-export them).
 *  - command names must match `/^[a-z][a-z0-9_-]*$/` — the design doc's
 *    `omicos:login` spelling is NOT registrable; we use `omicos-login`.
 *  - job labels are immutable after `start()`; live progress goes through
 *    `JobHooks.readOutput()` instead.
 */

export type { Context } from '@deepseek-ai/cordis'
export { default as Schema } from '@deepseek-ai/schemastery'

export { defineTool } from '@deepseek-ai/dsh-tools'
export type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

export type {
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'

export type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'

// Type-only: pulls the webServer Context merge for `ctx.get('webServer')`
// (optional service — the account-tab routes register only when present).
export type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/**
 * Register our job kind in dsh's merge-extensible kind map (verified
 * first-party pattern: module specifier is the PACKAGE ROOT, e.g.
 * tool-terminal's `pty-send` / tool-pwsh's `pwsh`).
 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'omicos-analysis': 'omicos-analysis'
  }
}

/** The four raster media types `attachments.saveImage` accepts (attachment/types.ts:8). */
export const SAVEABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * The dsh session identity of the agent driving a tool call:
 * `Agent.id: SessionId` is documented as "the single identity shared with
 * {@link session}" (agent/runtime-types.ts:64-67). `undefined` when the
 * tool is invoked outside an owning agent (`ToolExecution.agent` is
 * optional) — callers fall back to a shared bucket.
 */
export function dshSessionIdOf(exec: { agent?: { id: string } }): string | undefined {
  return exec.agent?.id
}

/**
 * The dsh AGENT's workspace directory: `SessionHeader.cwd` — "Absolute
 * working directory the session was created in (if any)"
 * (session/types.ts:73). This — not the host process cwd — is what the
 * user picked in the dsh workspace UI; binding the omicos kernel to the
 * host cwd spawned a stray second core on the first real user run.
 */
export function sessionCwdOf(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}
