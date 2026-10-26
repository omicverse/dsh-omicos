export interface BaseRuntimeSpec {
  schema: 'omicos.python-runtime/1'
  title: string
  version: string
  platform: 'darwin' | 'linux'
  arch: 'arm64' | 'x64'
  url: string
  allowedOrigins: string[]
  sha256: string
  bytes: number
  entrypoint: string
  license: { id: string; url: string }
  archiveFile?: string
}
export interface BaseRuntimeInstall {
  id: string
  operationId: string
  requestSha256: string
  spec: BaseRuntimeSpec
  state:
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'ready'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'removed'
  createdAt: string
  updatedAt: string
  downloaded: number
  interpreter: string
  manifestSha256?: string
  files?: number
  unpackedBytes?: number
  probe?: Record<string, unknown>
  error?: string
}
export interface BaseRuntimeSelection {
  revision: number
  runtimeId: string | null
  operationId?: string
  at: string
}
