/**
 * Login for the dsh host: RFC-8628 device code, the ONLY channel.
 *
 * Deliberately the only one — and it is enough for every account type:
 * the user approves in a real browser on the production SPA, where they
 * sign in however their account works (phone or email). The plugin never
 * sees a password or an SMS code, and adding a credential form here would
 * be strictly worse than the browser they already trust. (WeChat QR was
 * implemented and REMOVED: that channel is not enabled for this
 * deployment — only phone and email sign-in are.)
 *
 * The plugin persists NO tokens — an approved login is immediately pushed
 * to the local core (`POST /api/cloud/login`), whose `cloud_login.json` is
 * the single source of truth.
 *
 * Shaped for dsh's command surface: a `CommandDefinition.handler` returns
 * exactly ONE `CommandResult` (verified — there is no streaming print),
 * so `begin*Login` resolves fast with the text the user must see NOW
 * (pairing code / QR link) and finishes the approval poll + core push in
 * the background `done` promise. `/omicos-status` reads the outcome.
 *
 * dsh-free on purpose (the compat layer is for `commands.ts`); unit tests
 * drive these against the mock auth server without a dsh host.
 */
import {
  getCloudIdentity,
  pollDeviceCode,
  pushLoginToCore,
  pushLogoutToCore,
  startDeviceCode,
} from '@omicverse/omicos-client'
import type { CloudIdentity, PublicUser } from '@omicverse/omicos-protocol'
import type { KernelManager } from './kernel.js'

export interface LoginOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface BegunLogin {
  /** What the user must see immediately (the pairing code line) — the command result text. */
  message: string
  /** Structured display fields for graphical surfaces (the account tab renders these as a code + link). */
  verification_uri: string
  user_code: string
  /** Resolves once approved AND pushed to the local core; rejects on abort/HTTP failure. */
  done: Promise<PublicUser>
}

async function pushToCore(
  kernel: KernelManager,
  cloudBase: string,
  userToken: string,
  user: PublicUser,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const handle = await kernel.handle()
  // process_token is deliberately NOT forwarded — that field is reserved
  // for a driving core relaying to a remote one (protocol auth.ts).
  await pushLoginToCore(handle.baseUrl, { server: cloudBase, user_token: userToken, user }, fetchImpl)
}

/** RFC-8628 device-code login: resolve with the URL + code, then poll to approval and push to core in `done`. */
export async function beginDeviceCodeLogin(
  kernel: KernelManager,
  cloudBase: string,
  opts: LoginOptions = {},
): Promise<BegunLogin> {
  const minted = await startDeviceCode(cloudBase, opts.fetchImpl)
  const done = (async () => {
    const approved = await pollDeviceCode(cloudBase, minted.device_code, {
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    })
    await pushToCore(kernel, cloudBase, approved.user_token, approved.user, opts.fetchImpl)
    return approved.user
  })()
  return {
    message: `在浏览器打开 ${minted.verification_uri} 并输入配对码 ${minted.user_code}，用手机号或邮箱登录后批准（批准后运行 /omicos-status 查看结果）`,
    verification_uri: minted.verification_uri,
    user_code: minted.user_code,
    done,
  }
}

/** Current login state, read from the core (never from any plugin-side store). */
export async function loginStatus(kernel: KernelManager, fetchImpl?: typeof fetch): Promise<CloudIdentity> {
  const handle = await kernel.handle()
  return getCloudIdentity(handle.baseUrl, fetchImpl)
}

/** Log THIS machine's core out (does not revoke the token anywhere else — F10). */
export async function logout(kernel: KernelManager, fetchImpl?: typeof fetch): Promise<void> {
  const handle = await kernel.handle()
  await pushLogoutToCore(handle.baseUrl, fetchImpl)
}

export function describeUser(user: PublicUser): string {
  return user.email || user.phone || user.id
}
