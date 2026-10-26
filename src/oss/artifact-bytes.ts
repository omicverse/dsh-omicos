import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Artifact } from './types.js'
import { FigureError } from './figure-types.js'
/** Bounded reads from a contained regular file. Metadata never authorizes reading an arbitrary path. */
export async function artifactBytes(workspace: string, artifact: Artifact): Promise<Buffer> {
  workspace = await realpath(workspace)
  const path = await realpath(join(workspace, artifact.path))
  if (!path.startsWith(workspace + sep)) throw new FigureError(403, 'Artifact outside workspace')
  const max = 32 * 1024 * 1024
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > max) throw new FigureError(413, 'Artifact exceeds 32 MiB')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > max) throw new FigureError(413, 'Artifact must be a regular file at most 32 MiB')
    const bytes = Buffer.alloc(artifact.bytes + 1); let length = 0
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
    const result = bytes.subarray(0, length)
    if (length !== artifact.bytes || createHash('sha256').update(result).digest('hex') !== artifact.sha256) throw new FigureError(409, 'Artifact changed since execution')
    return result
  } finally { await file.close() }
}
