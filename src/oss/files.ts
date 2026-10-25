import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PRIVATE_PARTS = new Set(['.git', '.ssh', '.aws', '.omicos-oss', '.env', 'node_modules'])
export interface WorkspaceFile { name: string; path: string; directory: boolean; bytes: number; modified: string; kind: 'directory' | 'text' | 'image' | 'data' }
const TEXT = new Set(['.csv', '.tsv', '.txt', '.json', '.md', '.yaml', '.yml', '.mtx'])
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export async function workspacePath(workspace: string, path: string, sensitive: readonly string[] = []): Promise<string> {
  workspace = await realpath(workspace)
  if (isAbsolute(path) || path.includes('\\') || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => part === '..' || PRIVATE_PARTS.has(part) || part.startsWith('.env.'))) throw new Error('Use a project-relative path outside private/runtime directories')
  const file = await realpath(join(workspace, path))
  if (file !== workspace && !file.startsWith(workspace + sep)) throw new Error('Path resolves outside the project')
  if (relative(workspace, file).split(sep).some(part => PRIVATE_PARTS.has(part) || part.startsWith('.env.'))) throw new Error('Resolved path enters a private/runtime directory')
  const forbidden = await Promise.all(sensitive.map(async path => { try { return await realpath(path) } catch { return resolve(path) } }))
  if (forbidden.includes(file)) throw new Error('Private Host credentials cannot be served by the workspace browser')
  return file
}
export async function listWorkspace(workspace: string, path = '', sensitive: readonly string[] = []): Promise<{ path: string; entries: WorkspaceFile[]; truncated: boolean }> {
  workspace = await realpath(workspace)
  const directory = await workspacePath(workspace, path, sensitive)
  const all = await readdir(directory, { withFileTypes: true })
  const visible = all.filter(entry => !entry.name.startsWith('.') && !PRIVATE_PARTS.has(entry.name) && !entry.isSymbolicLink()).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const entries = await Promise.all(visible.slice(0, 300).map(async entry => {
    const file = await workspacePath(workspace, join(path, entry.name), sensitive)
    const info = await stat(file)
    const extension = extname(entry.name).toLowerCase()
    return { name: entry.name, path: relative(workspace, file).split(sep).join('/'), directory: info.isDirectory(), bytes: info.size, modified: info.mtime.toISOString(), kind: info.isDirectory() ? 'directory' : TEXT.has(extension) ? 'text' : IMAGE.has(extension) ? 'image' : 'data' } as WorkspaceFile
  }).map(async promise => { try { return await promise } catch { return undefined } }))
  return { path: relative(workspace, directory).split(sep).join('/'), entries: entries.filter((entry): entry is WorkspaceFile => entry !== undefined), truncated: visible.length > 300 }
}
export async function previewWorkspaceFile(workspace: string, path: string, sensitive: readonly string[] = []): Promise<{ path: string; bytes: number; text?: string; truncated?: boolean; kind: string }> {
  const file = await workspacePath(workspace, path, sensitive)
  const info = await stat(file)
  if (!info.isFile()) throw new Error('Not a regular file')
  if (!TEXT.has(extname(file).toLowerCase())) return { path, bytes: info.size, kind: 'data' }
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, 65536))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (buffer.subarray(0, bytesRead).includes(0)) return { path, bytes: info.size, kind: 'data' }
    return { path, bytes: info.size, kind: 'text', text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: info.size > bytesRead }
  } finally { await handle.close() }
}
