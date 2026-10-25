import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Atomic replacement on the same volume; never leave partially written metadata. */
export async function writeJson(path: string, data: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', mode)
    try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync() } finally { await file.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
