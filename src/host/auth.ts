/**
 * Login flows for the dsh host (DSH-PLUGIN.md §6): device code (works in
 * any environment) + WeChat QR (CN main path). The plugin persists NO
 * tokens — an approved login is immediately pushed to the local core
 * (`POST /api/cloud/login`), whose `cloud_login.json` is the single
 * source of truth.
 *
 * Shaped for dsh's command surface: a `CommandDefinition.handler` returns
 * exactly ONE `CommandResult` (verified — there is no streaming print),
 * so `begin*Login` resolves fast with the text the user must see NOW
 * (pairing code / QR link) and finishes the approval poll + core push in
 * the background `done` promise. `/omicos-status` reads the outcome.
 *
 * v0.1 renders the WeChat QR as its clickable `qr_url` (WeChat's own
 * hosted QR image — open it anywhere and scan from screen); ASCII QR is
 * deferred until the QR's *payload* URL is verified against production
 * (the response only carries the image URL, and guessing WeChat's
 * confirm-URL format would be an invented mechanism).
 *
 * dsh-free on purpose (the compat layer is for `commands.ts`); unit tests
 * drive these against the mock auth server without a dsh host.
 */
import {
  getCloudIdentity,
  pollDeviceCode,
  pollWechatQr,
  pushLoginToCore,
  pushLogoutToCore,
  startDeviceCode,
  startWechatQr,
} from '@omicverse/omicos-client'
import type { CloudIdentity, PublicUser } from '@omicverse/omicos-protocol'
import type { KernelManager } from './kernel.js'

export interface LoginOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface BegunLogin {
  /** What the user must see immediately (pairing code / QR link) — the command result text. */
  message: string
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
    message: `在浏览器打开 ${minted.verification_uri} 并输入配对码 ${minted.user_code}（批准后运行 /omicos-status 查看结果）`,
    done,
  }
}

/** WeChat QR login: resolve with the hosted QR image link, then long-poll to approval and push to core in `done`. */
export async function beginWechatLogin(
  kernel: KernelManager,
  cloudBase: string,
  opts: LoginOptions = {},
): Promise<BegunLogin> {
  const state = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const qr = await startWechatQr(cloudBase, state, opts.fetchImpl)
  const done = (async () => {
    const approved = await pollWechatQr(cloudBase, state, { signal: opts.signal, fetchImpl: opts.fetchImpl })
    await pushToCore(kernel, cloudBase, approved.token, approved.user, opts.fetchImpl)
    return approved.user
  })()
  return {
    message: `打开此链接并用微信扫码登录：${qr.qr_url}（确认后运行 /omicos-status 查看结果）`,
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
