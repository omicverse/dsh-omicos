export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const UPLOAD_MAX_BYTES = 10 * 1024 ** 3
export interface UploadRequest { operationId: string; directory: string; name: string; bytes: number; chunkHashes: string[]; expectedSha256?: string }
export interface DataUpload extends UploadRequest {
  id: string; state: 'uploading' | 'finalizing' | 'committing' | 'completed' | 'canceled' | 'failed'; received: number
  chunkSize: number; manifestSha256: string; requestSha256: string; target: string; targetDirectory: string; targetDirectoryIdentity: string; cleanupPending?: boolean
  createdAt: string; updatedAt: string; sha256?: string; error?: string
}
export type UploadSummary = Omit<DataUpload, 'chunkHashes' | 'requestSha256' | 'targetDirectory' | 'targetDirectoryIdentity'>
export class UploadError extends Error { constructor(readonly status: number, message: string) { super(message) } }

export function portableUploadName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !value.startsWith('.') && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) && !/[.\s]$/.test(value) && new TextEncoder().encode(value).length <= 240 && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}
