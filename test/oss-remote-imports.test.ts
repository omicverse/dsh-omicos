import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  appendFile,
  stat
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OssRuntime } from '../src/oss/runtime.js'
import {
  RemoteImports,
  normalizeRemoteImport
} from '../src/oss/remote-imports.js'
import { UPLOAD_CHUNK_BYTES } from '../src/oss/upload-types.js'
import type { RemoteImport } from '../src/oss/remote-import-types.js'
const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex')
let root: string,
  runtime: OssRuntime,
  manager: RemoteImports,
  server: Server,
  origin: string
let bytes = Buffer.alloc(2 * UPLOAD_CHUNK_BYTES + 37, 42)
let etag = '"source-v1"'
const seen: Array<{
  url?: string
  range?: string
  match?: string
  authorization?: string
  cookie?: string
}> = []
const stalls = new Set<any>()
beforeEach(async () => {
  bytes = Buffer.alloc(2 * UPLOAD_CHUNK_BYTES + 37, 42)
  root = await realpath(await mkdtemp(join(tmpdir(), 'oss-remote-')))
  runtime = await OssRuntime.open({
    stateDir: join(root, 'state'),
    python: '/must-not-run'
  })
  await runtime.project(root)
  manager = await RemoteImports.open(
    root,
    await runtime.uploads(root),
    runtime.sensitiveFiles,
    { fixtureLoopback: true }
  )
  seen.length = 0
  etag = '"source-v1"'
  server = createServer((request, response) => {
    seen.push({
      url: request.url,
      range: request.headers.range,
      match: request.headers['if-range'],
      authorization: request.headers.authorization,
      cookie: request.headers.cookie
    })
    if (request.url?.startsWith('/escape')) {
      response.writeHead(302, { location: 'https://unapproved.invalid/bytes' })
      response.end()
      return
    }
    if (request.url?.startsWith('/redirect')) {
      response.writeHead(302, { location: '/bytes?private=signed' })
      response.end()
      return
    }
    if (request.url?.startsWith('/encoded')) {
      response.writeHead(200, { 'content-encoding': 'gzip' })
      response.end(bytes)
      return
    }
    if (request.url?.startsWith('/unknown')) {
      response.writeHead(200)
      response.end(bytes)
      return
    }
    let offset = request.headers.range
      ? Number(request.headers.range.match(/bytes=(\d+)-/)?.[1])
      : 0
    if (request.url?.includes('ignore-range')) offset = 0
    const ranged = offset > 0
    response.writeHead(ranged ? 206 : 200, {
      'content-length': bytes.length - offset,
      etag,
      ...(ranged
        ? {
            'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`
          }
        : {})
    })
    if (
      (request.url?.startsWith('/stall') && !ranged) ||
      request.url?.startsWith('/gate')
    ) {
      if (!request.url?.startsWith('/gate'))
        response.write(bytes.subarray(0, UPLOAD_CHUNK_BYTES))
      stalls.add(response)
      response.once('close', () => stalls.delete(response))
    } else response.end(bytes.subarray(offset))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(async () => {
  for (const response of stalls) response.destroy()
  stalls.clear()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await manager.dispose()
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})
const request = (
  path = '/bytes',
  operationId = 'remote',
  name = 'dataset.bin'
) => ({
  operationId,
  url: origin + path,
  allowedOrigins: [origin],
  directory: '',
  name,
  expectedSha256: sha(bytes),
  expectedBytes: bytes.length
})
async function terminal(id: string) {
  let record = manager.get(id)
  const deadline = Date.now() + 25000
  while (
    ['downloading', 'publishing'].includes(record.state) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    record = manager.get(id)
  }
  return record
}
async function chunk(id: string) {
  for (let i = 0; i < 500; i++) {
    const record = manager.get(id)
    if (record.received >= UPLOAD_CHUNK_BYTES) return record
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw Error('Chunk was not committed')
}
it('validates production HTTPS origins and imports exact source bytes through the ordinary publisher without execution', async () => {
  for (const change of [
    { url: origin + '/bytes' },
    { url: 'https://user:pass@example.invalid/x' },
    { url: 'https://example.invalid/x#secret' },
    {
      url: 'https://example.invalid/x',
      allowedOrigins: ['https://different.invalid']
    },
    { url: 'https://example.invalid/x', expectedSha256: 'bad' },
    { url: 'https://example.invalid/x', expectedBytes: 11 * 1024 ** 3 }
  ])
    expect(() =>
      normalizeRemoteImport({
        ...request(),
        allowedOrigins: undefined,
        ...change
      })
    ).toThrow()
  const input = request('/redirect?hidden=credential'),
    record = await manager.start(input)
  expect((await manager.start(input)).id).toBe(record.id)
  await expect(
    manager.start({ ...input, name: 'changed.bin' })
  ).rejects.toMatchObject({ status: 409 })
  const done = await terminal(record.id)
  expect(done.error).toBeUndefined()
  expect(done.state).toBe('completed')
  expect(done.sha256).toBe(sha(bytes))
  expect((await readFile(join(root, 'dataset.bin'))).equals(bytes)).toBe(true)
  expect(seen.every((item) => !item.authorization && !item.cookie)).toBe(true)
  expect(JSON.stringify(manager.list())).not.toContain('credential')
  expect(JSON.stringify(manager.list())).not.toContain('signed')
  expect(JSON.stringify(manager.describe(record.id))).not.toContain(
    'credential'
  )
  expect(JSON.stringify(manager.describe(record.id))).not.toContain('signed')
  const upload = (await runtime.uploads(root)).get(done.uploadId!)
  expect(upload.state).toBe('completed')
  expect(upload.sha256).toBe(done.sha256)
  await expect(
    stat(join(root, '.omicos-oss', 'downloads', record.id + '.part'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await runtime.project(root)).snapshot().executions).toEqual([])
  await expect(manager.cancel(record.id)).rejects.toMatchObject({ status: 409 })
}, 30000)
it('pauses at durable chunks, verifies them after restart, and sends exact Range/If-Range without repeating a full transfer', async () => {
  const input = request('/stall'),
    record = await manager.start(input)
  await chunk(record.id)
  const paused = await manager.pause(record.id)
  expect(paused.state).toBe('paused')
  expect(paused.received).toBe(UPLOAD_CHUNK_BYTES)
  await appendFile(
    join(root, '.omicos-oss', 'downloads', record.id + '.part'),
    'uncommitted tail'
  )
  await manager.dispose()
  manager = await RemoteImports.open(
    root,
    await runtime.uploads(root),
    runtime.sensitiveFiles,
    { fixtureLoopback: true }
  )
  expect(manager.get(record.id).state).toBe('paused')
  expect(seen).toHaveLength(1)
  expect((await manager.start(input)).state).toBe('paused')
  await manager.resume(record.id)
  const done = await terminal(record.id)
  expect(done.error).toBeUndefined()
  expect(done.state).toBe('completed')
  expect(seen[1]).toMatchObject({
    range: `bytes=${UPLOAD_CHUNK_BYTES}-`,
    match: '"source-v1"'
  })
  expect((await readFile(join(root, 'dataset.bin'))).equals(bytes)).toBe(true)
}, 30000)
it('rejects changed ETags and local prefix drift before publishing, preserving private partial bytes for explicit cancellation', async () => {
  const first = await manager.start(request('/stall'))
  await chunk(first.id)
  await manager.pause(first.id)
  etag = '"changed"'
  await manager.resume(first.id)
  const failed = await terminal(first.id)
  expect(failed.state).toBe('failed')
  expect(failed.error).toMatch(/ETag/)
  expect(failed.received).toBe(UPLOAD_CHUNK_BYTES)
  await expect(stat(join(root, 'dataset.bin'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  const count = seen.length
  await writeFile(
    join(root, '.omicos-oss', 'downloads', first.id + '.part'),
    Buffer.alloc(UPLOAD_CHUNK_BYTES, 7)
  )
  await manager.resume(first.id)
  expect((await terminal(first.id)).error).toMatch(
    /Committed remote bytes changed/
  )
  expect(seen).toHaveLength(count)
  expect((await manager.cancel(first.id)).state).toBe('canceled')
  await expect(
    stat(join(root, '.omicos-oss', 'downloads', first.id + '.part'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)
it('rejects redirect escapes and checksum mismatches, supports unknown length, and never overwrites existing project files', async () => {
  let record = await manager.start(request('/escape', 'escape', 'escape.bin'))
  expect((await terminal(record.id)).error).toMatch(/origin was not approved/)
  expect(seen).toHaveLength(1)
  await manager.cancel(record.id)
  record = await manager.start({
    ...request('/bytes', 'bad-sha', 'bad.bin'),
    expectedSha256: 'a'.repeat(64)
  })
  expect((await terminal(record.id)).error).toMatch(/expected SHA-256/)
  await expect(stat(join(root, 'bad.bin'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  await manager.cancel(record.id)
  record = await manager.start({
    ...request('/unknown', 'unknown', 'unknown.bin'),
    expectedBytes: undefined,
    expectedSha256: undefined
  })
  const done = await terminal(record.id)
  expect(done.state, done.error).toBe('completed')
  expect(done.sha256).toBe(sha(bytes))
  expect(done.expectedSha256).toBeUndefined()
  await writeFile(join(root, 'exists.bin'), 'original')
  await expect(
    manager.start(request('/bytes', 'exists', 'exists.bin'))
  ).rejects.toMatchObject({ status: 409 })
  expect(await readFile(join(root, 'exists.bin'), 'utf8')).toBe('original')
}, 30000)
it('never treats a declared zero-length prefix as proven EOF, and rejects encoded source representations', async () => {
  bytes = Buffer.from('not an empty file')
  const record = await manager.start({
    ...request('/unknown', 'zero', 'zero.bin'),
    expectedBytes: 0,
    expectedSha256: undefined
  })
  expect((await terminal(record.id)).state).toBe('failed')
  await manager.resume(record.id)
  const failed = await terminal(record.id)
  expect(failed.state).toBe('failed')
  expect(failed.transferComplete).not.toBe(true)
  await expect(stat(join(root, 'zero.bin'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  await manager.cancel(record.id)
  const encoded = await manager.start(
    request('/encoded', 'encoded', 'encoded.bin')
  )
  expect((await terminal(encoded.id)).error).toMatch(/encoded bytes/)
  await manager.cancel(encoded.id)
}, 30000)
it('pins the destination directory before contacting a source and rejects replacement before publication', async () => {
  const { rename } = await import('node:fs/promises')
  bytes = Buffer.from('tiny dataset')
  await mkdir(join(root, 'target'))
  const record = await manager.start({
    ...request('/gate', 'directory', 'dataset.txt'),
    directory: 'target'
  })
  for (let i = 0; i < 200 && !stalls.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(stalls.size).toBe(1)
  await rename(join(root, 'target'), join(root, 'old-target'))
  await mkdir(join(root, 'target'))
  for (const response of stalls) response.end(bytes)
  const failed = await terminal(record.id)
  expect(failed.error).toMatch(/Destination directory changed/)
  await expect(stat(join(root, 'target', 'dataset.txt'))).rejects.toMatchObject(
    { code: 'ENOENT' }
  )
  await manager.cancel(record.id)
}, 30000)
it('does not silently accept a full 200 response when resuming a partial range', async () => {
  const record = await manager.start(request('/stall-ignore-range'))
  await chunk(record.id)
  await manager.pause(record.id)
  await manager.resume(record.id)
  const failed = await terminal(record.id)
  expect(failed.state).toBe('failed')
  expect(failed.error).toMatch(/range\/size\/strong ETag changed/)
  expect(failed.received).toBe(UPLOAD_CHUNK_BYTES)
  await manager.cancel(record.id)
}, 30000)
it('cancels only its own staging when an unrelated local upload used the same operation identity', async () => {
  bytes = Buffer.from('intended remote bytes')
  const record = await manager.start(
    request('/gate', 'collision', 'remote-source.txt')
  )
  for (let i = 0; i < 200 && !stalls.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(stalls.size).toBe(1)
  const other = Buffer.from('unrelated original file'),
    uploads = await runtime.uploads(root)
  const upload = await uploads.start({
    operationId: `remote-${record.id}`,
    directory: '',
    name: 'other.txt',
    bytes: other.length,
    chunkHashes: [sha(other)],
    expectedSha256: sha(other)
  })
  await uploads.chunk(upload.id, 0, other)
  await uploads.finalize(upload.id)
  for (const response of stalls) response.end(bytes)
  expect((await terminal(record.id)).state).toBe('failed')
  const canceled = await manager.cancel(record.id)
  expect(canceled.state).toBe('canceled')
  expect(canceled.uploadId).toBeUndefined()
  expect(uploads.get(upload.id).state).toBe('completed')
  expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe(other.toString())
  await expect(stat(join(root, 'remote-source.txt'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
}, 30000)
it('stops an actual in-flight source on disposal and reopens paused without any automatic request', async () => {
  const record = await manager.start(request('/stall', 'shutdown'))
  await chunk(record.id)
  await manager.dispose()
  const calls = seen.length
  manager = await RemoteImports.open(
    root,
    await runtime.uploads(root),
    runtime.sensitiveFiles,
    { fixtureLoopback: true }
  )
  expect(manager.get(record.id)).toMatchObject({
    state: 'paused',
    received: UPLOAD_CHUNK_BYTES
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seen).toHaveLength(calls)
  expect((await manager.cancel(record.id)).state).toBe('canceled')
  expect((await runtime.project(root)).kernelState().state).toBe('cold')
}, 30000)
it('bounds simultaneous transfers and staged files independently, releasing slots only through explicit actions', async () => {
  const records: RemoteImport[] = []
  records.push(await manager.start(request('/gate', 'one', 'one.bin')))
  records.push(await manager.start(request('/gate', 'two', 'two.bin')))
  await expect(
    manager.start(request('/gate', 'third-denied', 'three.bin'))
  ).rejects.toMatchObject({ status: 429 })
  for (const record of records) await manager.pause(record.id)
  records.push(await manager.start(request('/gate', 'three', 'three.bin')))
  records.push(await manager.start(request('/gate', 'four', 'four.bin')))
  for (const record of records) await manager.pause(record.id)
  await expect(
    manager.start(request('/gate', 'fifth-denied', 'five.bin'))
  ).rejects.toMatchObject({ status: 409 })
  expect(manager.list().entries).toHaveLength(4)
  for (const record of records)
    expect((await manager.cancel(record.id)).state).toBe('canceled')
}, 30000)
