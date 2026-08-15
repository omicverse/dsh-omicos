/**
 * Login flows for the dsh host (DSH-PLUGIN.md §6): device code (works in
 * any environment) + WeChat QR (CN main path). The plugin persists NO
 * tokens — an approved login is immediately pushed to the local core
 * (`POST /api/cloud/login`), whose `cloud_login.json` is the single
 * source of truth.
 *
 * dsh-free: output goes through an `io.print` sink so `commands.ts` can
 * route it to whatever surface dsh gives a command, and tests can capture
 * it. v0.1 renders the WeChat QR as its clickable `qr_url` (WeChat's own
 * hosted QR image — open it anywhere and scan from screen); ASCII QR via
 * qrcode-terminal is deferred until the QR's *payload* URL is verified
 * against production (the response only carries the image URL, and
 * guessing WeChat's confirm-URL format would be an invented mechanism).
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

export interface LoginIo {
  print(line: string): void
}

export interface LoginOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
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

/** RFC-8628 device-code login: print the URL + code, poll to approval, push to core. */
export async function loginWithDeviceCode(
  kernel: KernelManager,
  cloudBase: string,
  io: LoginIo,
  opts: LoginOptions = {},
): Promise<PublicUser> {
  const minted = await startDeviceCode(cloudBase, opts.fetchImpl)
  io.print(`在浏览器打开 ${minted.verification_uri} 并输入配对码：${minted.user_code}`)
  const approved = await pollDeviceCode(cloudBase, minted.device_code, {
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    onCode: (userCode, verificationUri) => {
      io.print(`配对码已过期，换新：在 ${verificationUri} 输入 ${userCode}`)
    },
  })
  await pushToCore(kernel, cloudBase, approved.user_token, approved.user, opts.fetchImpl)
  io.print(`已登录：${approved.user.email || approved.user.id}（token 已交给本地 omicos 内核保管）`)
  return approved.user
}

/** WeChat QR login: print the hosted QR image URL, long-poll to approval, push to core. */
export async function loginWithWechatQr(
  kernel: KernelManager,
  cloudBase: string,
  io: LoginIo,
  opts: LoginOptions = {},
): Promise<PublicUser> {
  const state = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const qr = await startWechatQr(cloudBase, state, opts.fetchImpl)
  io.print(`打开此链接并用微信扫码登录：${qr.qr_url}`)
  const approved = await pollWechatQr(cloudBase, state, {
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    onScanned: () => io.print('已扫码，请在手机上确认…'),
  })
  await pushToCore(kernel, cloudBase, approved.token, approved.user, opts.fetchImpl)
  io.print(`已登录：${approved.user.email || approved.user.id}（token 已交给本地 omicos 内核保管）`)
  return approved.user
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
