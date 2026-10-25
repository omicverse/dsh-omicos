/**
 * Harness Host compatibility boundary, verified against dsh-v0.2.1-rc.3.
 * Tool parameters use the Harness JSON-schema DSL; plugin configuration uses
 * the Host-provided Schemastery instance. Optional services are injected by
 * lifecycle scopes. Jobs use session-id ownership and JobHandle progress/output.
 * Third-party plugins must not write internal experimental Session records.
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

// Type-only: `ctx.get('sessionPersistence')` — the files tab resolves a
// dsh session's workspace (`SessionHeader.cwd`) through it after a host
// restart empties the kernel pool.
export type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

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

export type { JsonValue } from '@deepseek-ai/dsh-util-values'
