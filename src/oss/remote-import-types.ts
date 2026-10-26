export interface RemoteImportRequest {
  operationId: string
  url: string
  allowedOrigins?: string[]
  directory: string
  name: string
  expectedBytes?: number
  expectedSha256?: string
}
export interface RemoteImport extends RemoteImportRequest {
  id: string
  requestSha256: string
  state:
    | 'downloading'
    | 'paused'
    | 'publishing'
    | 'completed'
    | 'failed'
    | 'canceled'
  received: number
  createdAt: string
  updatedAt: string
  target: string
  targetDirectory: string
  targetDirectoryIdentity: string
  total?: number
  etag?: string
  resolvedUrl?: string
  bodyComplete?: boolean
  transferComplete?: boolean
  sha256?: string
  uploadId?: string
  error?: string
}
export class RemoteImportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
