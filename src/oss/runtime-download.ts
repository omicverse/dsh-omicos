import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { EnvironmentError } from './environment-types.js'
import type { BaseRuntimeSpec } from './base-runtime-types.js'
export function normalizeBaseRuntime(input: BaseRuntimeSpec): BaseRuntimeSpec {
  const text = (value: unknown, name: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new EnvironmentError(400, `Invalid runtime ${name}`)
    return value
  }
  const url = (value: unknown) => {
    try {
      const parsed = new URL(text(value, 'URL', 3000))
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw Error()
      return parsed
    } catch {
      throw new EnvironmentError(
        400,
        'Runtime URLs must be credential-free HTTPS URLs without fragments'
      )
    }
  }
  if (
    !input ||
    input.schema !== 'omicos.python-runtime/1' ||
    !['darwin', 'linux'].includes(input.platform) ||
    !['arm64', 'x64'].includes(input.arch) ||
    !/^3\.(?:1[0-9])\.\d+$/.test(input.version)
  )
    throw new EnvironmentError(
      400,
      'Choose a supported exact CPython 3.10+ runtime/platform descriptor'
    )
  const source = url(input.url)
  if (
    !Array.isArray(input.allowedOrigins) ||
    !input.allowedOrigins.length ||
    input.allowedOrigins.length > 8
  )
    throw new EnvironmentError(
      400,
      'Declare 1–8 explicitly allowed HTTPS download origins'
    )
  const origins = [
    ...new Set(
      input.allowedOrigins.map((value) => {
        const parsed = url(value)
        if (parsed.pathname !== '/' || parsed.search)
          throw new EnvironmentError(
            400,
            'Allowed download origins cannot contain paths or queries'
          )
        return parsed.origin
      })
    )
  ].sort()
  if (!origins.includes(source.origin))
    throw new EnvironmentError(400, 'Initial runtime URL origin is not allowed')
  if (
    !/^[a-fA-F0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 512 * 1024 * 1024
  )
    throw new EnvironmentError(
      400,
      'Runtime archive needs an exact SHA-256 and size up to 512 MiB'
    )
  const entrypoint = input.entrypoint
  if (
    typeof entrypoint !== 'string' ||
    entrypoint.length > 500 ||
    !entrypoint.startsWith('python/') ||
    entrypoint
      .split('/')
      .some(
        (part) =>
          !/[A-Za-z0-9_+@(),=-]/.test(part[0] || '') ||
          !/^[A-Za-z0-9_.+@(),=-]+$/.test(part) ||
          part === '.' ||
          part === '..'
      )
  )
    throw new EnvironmentError(
      400,
      'Use an explicit python/ relative interpreter entrypoint'
    )
  if (
    !input.license ||
    typeof input.license.id !== 'string' ||
    !input.license.id.trim() ||
    input.license.id.length > 200
  )
    throw new EnvironmentError(400, 'A runtime license declaration is required')
  const archiveFile =
    input.archiveFile === undefined
      ? undefined
      : text(input.archiveFile, 'offline archive path', 2000)
  if (archiveFile !== undefined && !isAbsolute(archiveFile))
    throw new EnvironmentError(
      400,
      'Offline runtime archive must use an absolute path'
    )
  return {
    schema: 'omicos.python-runtime/1',
    title: text(input.title, 'title', 200),
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    url: source.toString(),
    allowedOrigins: origins,
    sha256: input.sha256.toLowerCase(),
    bytes: input.bytes,
    entrypoint: input.entrypoint,
    license: { id: input.license.id, url: url(input.license.url).toString() },
    ...(archiveFile ? { archiveFile } : {})
  }
}
/** No cloud cookies/keys. Redirects must remain within the explicitly approved origin set. */
export async function stageRuntimeArchive(
  spec: BaseRuntimeSpec,
  file: string,
  signal: AbortSignal,
  progress: (bytes: number) => void = () => {},
  fixtureLoopback = false
): Promise<void> {
  let response: Response | undefined,
    source: Awaited<ReturnType<typeof open>> | undefined,
    target: Awaited<ReturnType<typeof open>> | undefined
  try {
    signal.throwIfAborted()
    let stream: AsyncIterable<Uint8Array>
    if (spec.archiveFile) {
      source = await open(
        spec.archiveFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      const status = await source.stat()
      if (!status.isFile() || status.size !== spec.bytes)
        throw new EnvironmentError(
          409,
          'Offline runtime archive is not a regular file of the declared size'
        )
      stream = source.createReadStream({ autoClose: false })
    } else {
      let current = new URL(spec.url)
      for (let redirects = 0; redirects <= 5; redirects++) {
        const loopback =
          fixtureLoopback &&
          current.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(current.hostname)
        if (
          (current.protocol !== 'https:' && !loopback) ||
          current.username ||
          current.password ||
          !spec.allowedOrigins.includes(current.origin)
        )
          throw new EnvironmentError(
            403,
            'Runtime download redirect origin was not explicitly approved'
          )
        response = await fetch(current, {
          signal,
          redirect: 'manual',
          headers: { accept: 'application/octet-stream' }
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location)
            throw new EnvironmentError(
              502,
              'Runtime redirect omitted its destination'
            )
          current = new URL(location, current)
          continue
        }
        break
      }
      if (!response?.ok || !response.body)
        throw new EnvironmentError(
          502,
          `Runtime download failed (${response?.status ?? 'no response'}); no executable was started`
        )
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) !== spec.bytes) {
        await response.body.cancel()
        throw new EnvironmentError(
          409,
          'Runtime download size differs from its approved descriptor'
        )
      }
      stream = response.body as unknown as AsyncIterable<Uint8Array>
    }
    target = await open(file, 'wx', 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of stream) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > spec.bytes)
        throw new EnvironmentError(
          413,
          'Runtime archive exceeded its approved byte length'
        )
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        signal.throwIfAborted()
        const wrote = await target.write(
          chunk,
          offset,
          chunk.byteLength - offset
        )
        if (!wrote.bytesWritten)
          throw Error('Runtime archive write made no progress')
        offset += wrote.bytesWritten
      }
      progress(bytes)
    }
    signal.throwIfAborted()
    if (bytes !== spec.bytes || hash.digest('hex') !== spec.sha256)
      throw new EnvironmentError(
        409,
        'Runtime archive size/SHA-256 does not match its approved descriptor'
      )
    await target.sync()
  } finally {
    await response?.body?.cancel().catch(() => {})
    await source?.close()
    await target?.close()
  }
}
