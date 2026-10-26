import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  stat
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Header } from 'tar'
import { unpackRuntimeArchive } from '../src/oss/runtime-archive.js'
import {
  normalizeBaseRuntime,
  stageRuntimeArchive
} from '../src/oss/runtime-download.js'
import type { BaseRuntimeSpec } from '../src/oss/base-runtime-types.js'
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oss-runtime-archive-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function archive(
  entries: Array<{
    path: string
    type?: string
    body?: string
    linkpath?: string
    mode?: number
    size?: number
  }>
) {
  return gzipSync(
    Buffer.concat([
      ...entries.flatMap((entry) => {
        const body = Buffer.from(entry.body || ''),
          size = entry.size ?? body.length,
          header = Buffer.alloc(512)
        new Header({
          path: entry.path,
          type: (entry.type || 'File') as any,
          size,
          mode: entry.mode ?? 0o755,
          linkpath: entry.linkpath
        }).encode(header)
        return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]
      }),
      Buffer.alloc(1024)
    ])
  )
}
async function prepare(bytes: Buffer) {
  const file = join(root, `archive-${Math.random()}.tar.gz`),
    destination = join(root, `unpack-${Math.random()}`)
  await writeFile(file, bytes)
  await mkdir(destination)
  const spec = normalizeBaseRuntime({
    schema: 'omicos.python-runtime/1',
    title: 'Fixture',
    version: '3.12.15',
    platform: 'darwin',
    arch: 'arm64',
    url: 'https://example.invalid/runtime.tar.gz',
    allowedOrigins: ['https://example.invalid'],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    entrypoint: 'python/bin/python3',
    license: { id: 'Fixture', url: 'https://example.invalid/license' },
    archiveFile: file
  })
  return { file, destination, spec }
}
it('validates descriptor origins/platform/hash and stages exact offline bytes without overwrite', async () => {
  const bytes = archive([{ path: 'python/bin/python3', body: 'fixture' }]),
    { file, spec } = await prepare(bytes),
    staged = join(root, 'staged.tar.gz')
  await stageRuntimeArchive(spec, staged, new AbortController().signal)
  expect(await readFile(staged)).toEqual(bytes)
  await expect(
    stageRuntimeArchive(spec, staged, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'EEXIST' })
  for (const change of [
    { url: 'http://example.invalid/x' },
    { allowedOrigins: ['https://other.invalid'] },
    { sha256: 'bad' },
    { entrypoint: 'python/../outside' },
    { entrypoint: 'python/bin/a'.repeat(1000) },
    { bytes: 1024 ** 3 },
    { license: { id: '', url: 'https://example.invalid' } }
  ])
    expect(() =>
      normalizeBaseRuntime({ ...spec, ...change } as BaseRuntimeSpec)
    ).toThrow()
  await expect(
    stageRuntimeArchive(
      { ...spec, sha256: 'a'.repeat(64) },
      join(root, 'wrong.tar.gz'),
      new AbortController().signal
    )
  ).rejects.toMatchObject({ status: 409 })
  expect((await stat(file)).size).toBe(bytes.length)
})
it('extracts regular files and resolves internal symlinks/hardlinks only after all regular files', async () => {
  const bytes = archive([
      {
        path: 'python/bin/python3',
        type: 'SymbolicLink',
        linkpath: 'python3.12'
      },
      { path: 'python/bin/python3.12', body: 'native fixture', mode: 0o755 },
      { path: 'python/lib/example.py', body: 'print(42)', mode: 0o644 },
      {
        path: 'python/bin/copy',
        type: 'Link',
        linkpath: 'python/bin/python3.12'
      }
    ]),
    { file, destination, spec } = await prepare(bytes)
  const manifest = await unpackRuntimeArchive(
    spec,
    file,
    destination,
    new AbortController().signal
  )
  expect(await readFile(join(destination, 'python/bin/python3'), 'utf8')).toBe(
    'native fixture'
  )
  expect(
    manifest.entries.find((entry) => entry.path === 'python/bin/python3')
  ).toMatchObject({ type: 'symlink', target: 'python3.12' })
  expect(
    manifest.entries.find((entry) => entry.path === 'python/bin/copy')
  ).toMatchObject({
    type: 'file',
    sha256: createHash('sha256').update('native fixture').digest('hex')
  })
  expect(
    (await stat(join(destination, 'python/lib/example.py'))).mode & 0o777
  ).toBe(0o600)
})
it('rejects escaping paths, duplicates, links, declared bombs and cyclic targets without writing outside staging', async () => {
  const base = { path: 'python/bin/python3', body: 'native fixture' }
  const cases = [
    [{ path: 'python/../../escape', body: 'bad' }],
    [base, base],
    [base, { path: 'python/BIN/python3', body: 'case alias' }],
    [
      {
        path: 'python/bin/python3',
        type: 'SymbolicLink',
        linkpath: '../../../escape'
      }
    ],
    [
      { path: 'python/bin/python3', type: 'SymbolicLink', linkpath: 'other' },
      { path: 'python/bin/other', type: 'SymbolicLink', linkpath: 'python3' }
    ],
    [{ path: 'python/bin/python3', size: 300 * 1024 ** 2 }],
    [base, { path: 'python/fifo', type: 'FIFO' }]
  ]
  for (const entries of cases) {
    const fixture = await prepare(archive(entries))
    await expect(
      unpackRuntimeArchive(
        fixture.spec,
        fixture.file,
        fixture.destination,
        new AbortController().signal
      )
    ).rejects.toThrow()
  }
  await expect(stat(join(root, 'escape'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  // Lexical containment alone is insufficient when a target traverses directory symlinks.
  const fixture = await prepare(
    archive([
      base,
      { path: 'python/outside', body: 'decoy' },
      { path: 'python/a', type: 'SymbolicLink', linkpath: '.' },
      {
        path: 'python/bin/leak',
        type: 'SymbolicLink',
        linkpath: '../a/a/../../outside'
      }
    ])
  )
  await writeFile(join(root, 'outside'), 'private fixture')
  await expect(
    unpackRuntimeArchive(
      fixture.spec,
      fixture.file,
      fixture.destination,
      new AbortController().signal
    )
  ).rejects.toThrow(/resolves outside/)
  expect(await readFile(join(root, 'outside'), 'utf8')).toBe('private fixture')
})
it('allows only approved redirect origins, sends no account credentials, bounds bytes, and cancels a stalled transfer', async () => {
  const { createServer } = await import('node:http')
  const seen: Array<{ url?: string; authorization?: string; cookie?: string }> =
    []
  let origin = ''
  const bytes = Buffer.from('exact archive fixture')
  const server = createServer((request, response) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie
    })
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/archive' })
      response.end()
    } else if (request.url === '/escape') {
      response.writeHead(302, {
        location: 'https://not-approved.invalid/archive'
      })
      response.end()
    } else if (request.url === '/stall') {
      response.writeHead(200)
      response.write(bytes.subarray(0, 1))
    } else if (request.url === '/long') {
      response.writeHead(200)
      response.end(Buffer.concat([bytes, bytes]))
    } else {
      response.writeHead(200, { 'content-length': bytes.length })
      response.end(bytes)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const fixture = await prepare(
      archive([{ path: 'python/bin/python3', body: 'fixture' }])
    )
    const spec = {
      ...fixture.spec,
      archiveFile: undefined,
      url: origin + '/redirect',
      allowedOrigins: [origin],
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    await stageRuntimeArchive(
      spec,
      join(root, 'http.tar.gz'),
      new AbortController().signal,
      () => {},
      true
    )
    expect(await readFile(join(root, 'http.tar.gz'))).toEqual(bytes)
    expect(seen.every((item) => !item.authorization && !item.cookie)).toBe(true)
    await expect(
      stageRuntimeArchive(
        { ...spec, url: origin + '/escape' },
        join(root, 'escape-http'),
        new AbortController().signal,
        () => {},
        true
      )
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      stageRuntimeArchive(
        { ...spec, url: origin + '/long' },
        join(root, 'long-http'),
        new AbortController().signal,
        () => {},
        true
      )
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      stageRuntimeArchive(
        { ...spec, url: origin + '/stall' },
        join(root, 'stall-http'),
        AbortSignal.timeout(100),
        () => {},
        true
      )
    ).rejects.toThrow()
    expect(seen.filter((item) => item.url === '/stall')).toHaveLength(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
it.skipIf(process.platform === 'win32')(
  'rejects an offline FIFO immediately instead of blocking a Host on open',
  async () => {
    const { execFileSync } = await import('node:child_process')
    const { spec } = await prepare(
      archive([{ path: 'python/bin/python3', body: 'fixture' }])
    )
    const fifo = join(root, 'fifo')
    execFileSync('mkfifo', [fifo])
    await expect(
      stageRuntimeArchive(
        { ...spec, archiveFile: fifo },
        join(root, 'fifo-copy'),
        AbortSignal.timeout(100)
      )
    ).rejects.toMatchObject({ status: 409 })
  }
)
