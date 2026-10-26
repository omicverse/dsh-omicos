import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, realpath, chmod, stat, lstat, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { workspacePath } from './files.js'
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
  portableUploadName
} from './upload-types.js'
import {
  RemoteImportError,
  type RemoteImportRequest,
  type RemoteImport
} from './remote-import-types.js'
import type { DataUploads } from './uploads.js'
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite')
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value))
    throw new RemoteImportError(400, 'Invalid remote import identity')
  return value
}
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new RemoteImportError(400, 'Invalid remote source value')
  return value
}
export function normalizeRemoteImport(
  input: RemoteImportRequest,
  fixtureLoopback = false
): RemoteImportRequest {
  if (!input || typeof input !== 'object')
    throw new RemoteImportError(400, 'Remote import request required')
  identity(input.operationId)
  const source = (value: unknown) => {
    let url: URL
    try {
      url = new URL(text(value, 4000))
    } catch {
      throw new RemoteImportError(400, 'Invalid source URL')
    }
    if (
      (url.protocol !== 'https:' &&
        !(
          fixtureLoopback &&
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new RemoteImportError(
        400,
        'Use credential-free HTTPS source URLs without fragments'
      )
    return url
  }
  const url = source(input.url),
    origins = input.allowedOrigins ?? [url.origin]
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 8)
    throw new RemoteImportError(400, 'Declare 1–8 source/redirect origins')
  const allowedOrigins = [
    ...new Set(
      origins.map((value) => {
        const parsed = source(value)
        if (parsed.pathname !== '/' || parsed.search)
          throw new RemoteImportError(
            400,
            'Allowed origins cannot contain paths/queries'
          )
        return parsed.origin
      })
    )
  ].sort()
  if (!allowedOrigins.includes(url.origin))
    throw new RemoteImportError(400, 'Initial source origin is not allowed')
  if (
    typeof input.directory !== 'string' ||
    input.directory.length > 2000 ||
    !portableUploadName(input.name)
  )
    throw new RemoteImportError(
      400,
      'Use a portable file name and existing project-relative directory'
    )
  if (
    input.expectedBytes !== undefined &&
    (!Number.isSafeInteger(input.expectedBytes) ||
      input.expectedBytes < 0 ||
      input.expectedBytes > UPLOAD_MAX_BYTES)
  )
    throw new RemoteImportError(400, 'Expected size must be 0–10 GiB')
  if (
    input.expectedSha256 !== undefined &&
    (typeof input.expectedSha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(input.expectedSha256))
  )
    throw new RemoteImportError(
      400,
      'Expected SHA-256 must have 64 hex characters'
    )
  return {
    operationId: input.operationId,
    url: url.href,
    allowedOrigins,
    directory: input.directory,
    name: input.name,
    ...(input.expectedBytes !== undefined
      ? { expectedBytes: input.expectedBytes }
      : {}),
    ...(input.expectedSha256 !== undefined
      ? { expectedSha256: input.expectedSha256.toLowerCase() }
      : {})
  }
}
const publicUrl = (url: string) => {
  const parsed = new URL(url)
  return parsed.origin + parsed.pathname
}
export class RemoteImports {
  private tasks = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >()
  private writes: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposing?: Promise<void>
  private constructor(
    private db: Database,
    readonly workspace: string,
    private uploads: DataUploads,
    private sensitive: readonly string[],
    private fixtureLoopback: boolean
  ) {}
  static async open(
    workspace: string,
    uploads: DataUploads,
    sensitive: readonly string[],
    options: { fixtureLoopback?: boolean } = {}
  ): Promise<RemoteImports> {
    workspace = await realpath(workspace)
    const directory = join(workspace, '.omicos-oss', 'downloads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await realpath(directory)) !== directory)
      throw new RemoteImportError(
        403,
        'Download staging cannot be a symbolic link'
      )
    await chmod(directory, 0o700)
    const path = join(workspace, '.omicos-oss', 'downloads.sqlite'),
      file = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      )
    try {
      if (!(await file.stat()).isFile())
        throw new RemoteImportError(409, 'Download ledger must be regular')
    } finally {
      await file.close()
    }
    await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    try {
      const version = Number(
          db.prepare('PRAGMA user_version').get()!.user_version
        ),
        app = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (
        version > 1 ||
        (app !== 0 && app !== 0x4f524449) ||
        (version && app !== 0x4f524449)
      )
        throw new RemoteImportError(
          409,
          'Unsupported download ledger; preserve its files'
        )
      db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      if (!version) {
        if (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
            .all().length
        )
          throw new RemoteImportError(409, 'Unknown download ledger')
        db.exec(
          `BEGIN IMMEDIATE;CREATE TABLE downloads(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE,record_json TEXT NOT NULL);CREATE TABLE chunks(download_id TEXT,idx INTEGER,bytes INTEGER,sha256 TEXT,PRIMARY KEY(download_id,idx));PRAGMA application_id=${0x4f524449};PRAGMA user_version=1;COMMIT;`
        )
      }
      const manager = new RemoteImports(
        db,
        workspace,
        uploads,
        sensitive,
        Boolean(options.fixtureLoopback)
      )
      for (const row of db
        .prepare(
          "SELECT id FROM downloads WHERE json_extract(record_json,'$.state') IN ('downloading','publishing')"
        )
        .all())
        manager.update(String(row.id), {
          state: 'paused',
          error:
            'Host stopped; inspect the receipt and resume explicitly. No network transfer or publication is restarted.'
        })
      return manager
    } catch (error) {
      db.close()
      throw error
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new RemoteImportError(503, 'Remote imports are closing')
      )
    const task = this.writes.then(fn)
    this.writes = task.catch(() => {})
    return task
  }
  private stage(id: string) {
    return join(
      this.workspace,
      '.omicos-oss',
      'downloads',
      `${identity(id)}.part`
    )
  }
  private async syncDirectory(){const directory=join(this.workspace,'.omicos-oss','downloads');if(await realpath(directory)!==directory)throw new RemoteImportError(403,'Download staging directory changed');const file=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!(await file.stat()).isDirectory())throw new RemoteImportError(409,'Download staging is not a directory');await file.sync()}finally{await file.close()}}
  private async removeStage(id:string){const directory=join(this.workspace,'.omicos-oss','downloads');if(await realpath(directory)!==directory)throw new RemoteImportError(403,'Download staging directory changed');await rm(this.stage(id),{force:true});await this.syncDirectory()}
  get(id: string): RemoteImport {
    identity(id)
    const row = this.db
      .prepare('SELECT record_json FROM downloads WHERE id=?')
      .get(id)
    if (!row) throw new RemoteImportError(404, 'Remote import not found')
    const record = JSON.parse(String(row.record_json)) as RemoteImport
    const request = normalizeRemoteImport(record, this.fixtureLoopback)
    if (
      record.id !== id ||
      record.requestSha256 !== hash(JSON.stringify(request)) ||
      !Number.isSafeInteger(record.received) ||
      record.received < 0 ||
      record.received > UPLOAD_MAX_BYTES
    )
      throw new RemoteImportError(
        409,
        'Remote source identity/progress changed'
      )
    return record
  }
  describe(id: string) {
    const record = this.get(id)
    return {
      id: record.id,
      state: record.state,
      source: publicUrl(record.url),
      resolvedSource: record.resolvedUrl
        ? publicUrl(record.resolvedUrl)
        : undefined,
      target: record.target,
      received: record.received,
      total: record.total,
      etag: record.etag,
      expectedBytes: record.expectedBytes,
      expectedSha256: record.expectedSha256,
      sha256: record.sha256,
      uploadId: record.uploadId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      error: record.error
    }
  }
  private update(id: string, fields: Partial<RemoteImport>) {
    const record = {
      ...this.get(id),
      ...fields,
      updatedAt: new Date().toISOString()
    }
    this.db
      .prepare('UPDATE downloads SET record_json=? WHERE id=?')
      .run(JSON.stringify(record), id)
    return record
  }
  list(before = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(before) || before < 1)
      throw new RemoteImportError(400, 'Invalid remote import cursor')
    const rows = this.db
      .prepare(
        'SELECT rowid,id FROM downloads WHERE rowid<? ORDER BY rowid DESC LIMIT 51'
      )
      .all(before)
    return {
      entries: rows.slice(0, 50).map((row) => {
        const record = this.get(String(row.id))
        return {
          id: record.id,
          state: record.state,
          target: record.target,
          received: record.received,
          total: record.total,
          source: publicUrl(record.url),
          sha256: record.sha256,
          expectedSha256: record.expectedSha256,
          uploadId: record.uploadId,
          updatedAt: record.updatedAt,
          error: record.error,
          resumable: Boolean(
            record.bodyComplete ||
              record.transferComplete ||
              (record.etag &&
                record.total !== undefined &&
                record.received % UPLOAD_CHUNK_BYTES === 0 &&
                record.received < record.total)
          )
        }
      }),
      next: rows.length > 50 ? Number(rows[49].rowid) : undefined,
      maxBytes: UPLOAD_MAX_BYTES
    }
  }
  private async destination(request: RemoteImportRequest) {
    let directory: string
    try {
      directory = await workspacePath(
        this.workspace,
        request.directory,
        this.sensitive
      )
    } catch {
      throw new RemoteImportError(
        403,
        'Choose an existing project directory outside private Host data'
      )
    }
    const info = await stat(directory, { bigint: true })
    if (!info.isDirectory())
      throw new RemoteImportError(400, 'Destination must be a directory')
    return {
      targetDirectory: directory,
      targetDirectoryIdentity: `${info.dev}:${info.ino}`,
      target: relative(this.workspace, join(directory, request.name))
        .split(sep)
        .join('/')
    }
  }
  start(input: RemoteImportRequest): Promise<RemoteImport> {
    return this.serial(async () => {
      const request = normalizeRemoteImport(input, this.fixtureLoopback),
        requestSha256 = hash(JSON.stringify(request)),
        old = this.db
          .prepare('SELECT id FROM downloads WHERE operation_id=?')
          .get(request.operationId)
      if (old) {
        const record = this.get(String(old.id))
        if (record.requestSha256 !== requestSha256)
          throw new RemoteImportError(
            409,
            'Remote operation belongs to another source/request'
          )
        return record
      }
      if (this.tasks.size >= 2)
        throw new RemoteImportError(
          429,
          'Two remote imports are already running'
        )
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM downloads WHERE json_extract(record_json,'$.state') NOT IN ('completed','canceled')"
            )
            .get()!.n
        ) >= 4
      )
        throw new RemoteImportError(
          409,
          'Four remote files already occupy staging; finish or cancel one first'
        )
      const destination = await this.destination(request)
      try {
        await lstat(join(destination.targetDirectory, request.name))
        throw new RemoteImportError(
          409,
          'Destination exists; choose another file name'
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        this.db
          .prepare(
            "SELECT id FROM downloads WHERE json_extract(record_json,'$.target')=? AND json_extract(record_json,'$.state') NOT IN ('completed','canceled')"
          )
          .get(destination.target)
      )
        throw new RemoteImportError(
          409,
          'An unfinished remote import already uses this target'
        )
      const id = randomUUID(),
        at = new Date().toISOString(),
        file = await open(this.stage(id), 'wx', 0o600)
      await file.sync()
      await file.close()
      await this.syncDirectory()
      const record: RemoteImport = {
        ...request,
        ...destination,
        id,
        requestSha256,
        state: 'paused',
        received: 0,
        createdAt: at,
        updatedAt: at
      }
      this.db
        .prepare('INSERT INTO downloads VALUES(?,?,?)')
        .run(id, request.operationId, JSON.stringify(record))
      this.launch(id)
      return this.get(id)
    })
  }
  private launch(id: string) {
    if (this.closing)
      throw new RemoteImportError(503, 'Remote imports are closing')
    if (this.tasks.has(id)) return
    if (this.tasks.size >= 2)
      throw new RemoteImportError(429, 'Two remote imports are already running')
    const controller = new AbortController()
    this.update(id, {
      state: this.get(id).transferComplete ? 'publishing' : 'downloading',
      error: undefined
    })
    const task = this.run(
      id,
      AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)])
    )
    this.tasks.set(id, { controller, task })
    void task.finally(() => this.tasks.delete(id)).catch(() => {})
  }
  resume(id: string): Promise<RemoteImport> {
    return this.serial(async () => {
      const record = this.get(id)
      if (this.tasks.has(id) || record.state === 'completed') return record
      if (record.state === 'canceled')
        throw new RemoteImportError(409, 'Canceled sources cannot resume')
      if (
        record.received &&
        !record.transferComplete &&
        !record.bodyComplete &&
        (!record.etag ||
          record.total === undefined ||
          record.received % UPLOAD_CHUNK_BYTES !== 0 ||
          record.received >= record.total)
      )
        throw new RemoteImportError(
          409,
          'This interrupted source has no strong ETag/size; explicitly cancel it and create a new import'
        )
      this.launch(id)
      return this.get(id)
    })
  }
  private async fetch(
    record: RemoteImport,
    signal: AbortSignal
  ): Promise<{ response: Response; url: string }> {
    let url = new URL(record.url)
    for (let i = 0; i <= 5; i++) {
      if (!record.allowedOrigins!.includes(url.origin))
        throw new RemoteImportError(403, 'Redirect origin was not approved')
      normalizeRemoteImport({ ...record, url: url.href }, this.fixtureLoopback)
      const response = await fetch(url, {
        signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept: 'application/octet-stream',
          'accept-encoding': 'identity',
          ...(record.received
            ? { range: `bytes=${record.received}-`, 'if-range': record.etag! }
            : {})
        }
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location)
          throw new RemoteImportError(
            502,
            'Source redirect omitted its destination'
          )
        url = new URL(location, url)
        continue
      }
      return { response, url: url.href }
    }
    throw new RemoteImportError(502, 'Source exceeded five redirects')
  }
  private async openStage(record: RemoteImport) {
    if ((await realpath(this.stage(record.id))) !== this.stage(record.id))
      throw new RemoteImportError(403, 'Remote staging path changed')
    const file = await open(
      this.stage(record.id),
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const status = await file.stat()
      if (!status.isFile() || status.size < record.received)
        throw new RemoteImportError(409, 'Downloaded staging bytes are missing')
      await file.truncate(record.received)
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }
  private async verifyChunks(
    record: RemoteImport,
    file: Awaited<ReturnType<typeof open>>,
    signal: AbortSignal
  ) {
    let offset = 0
    const digest = createHash('sha256')
    const rows = this.db
      .prepare(
        'SELECT idx,bytes,sha256 FROM chunks WHERE download_id=? ORDER BY idx'
      )
      .iterate(record.id)
    for (const row of rows) {
      signal.throwIfAborted()
      const size = Number(row.bytes)
      if (
        Number(row.idx) !== offset / UPLOAD_CHUNK_BYTES ||
        size < 1 ||
        size > UPLOAD_CHUNK_BYTES ||
        offset + size > record.received
      )
        throw new RemoteImportError(
          409,
          'Invalid committed remote chunk manifest'
        )
      const bytes = Buffer.alloc(size)
      let done = 0
      while (done < size) {
        const part = await file.read(bytes, done, size - done, offset + done)
        if (!part.bytesRead)
          throw new RemoteImportError(409, 'Committed remote chunk ended early')
        done += part.bytesRead
      }
      if (hash(bytes) !== row.sha256)
        throw new RemoteImportError(
          409,
          'Committed remote bytes changed; cancel instead of resuming'
        )
      digest.update(bytes)
      offset += size
    }
    if (offset !== record.received)
      throw new RemoteImportError(409, 'Remote chunk manifest has a gap')
    return digest
  }
  private async commit(
    id: string,
    file: Awaited<ReturnType<typeof open>>,
    offset: number,
    bytes: Buffer,
    fields: Partial<RemoteImport> = {}
  ) {
    let written = 0
    while (written < bytes.length) {
      const result = await file.write(
        bytes,
        written,
        bytes.length - written,
        offset + written
      )
      if (!result.bytesWritten)
        throw new Error('Remote staging write made no progress')
      written += result.bytesWritten
    }
    await file.sync()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO chunks VALUES(?,?,?,?)')
        .run(id, offset / UPLOAD_CHUNK_BYTES, bytes.length, hash(bytes))
      this.update(id, { ...fields, received: offset + bytes.length })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    let response: Response | undefined,
      file: Awaited<ReturnType<typeof open>> | undefined
    try {
      let record = this.get(id)
      const prior = this.uploads.byOperation(`remote-${id}`)
      if (prior?.state === 'completed') {
        if (
          !record.transferComplete ||
          prior.sha256 !== record.sha256 ||
          prior.bytes !== record.received ||
          prior.target !== record.target
        )
          throw new RemoteImportError(
            409,
            'Publication receipt does not match the remote source'
          )
        this.update(id, {
          state: 'completed',
          uploadId: prior.id,
          error: undefined
        })
        await this.removeStage(id)
        return
      }
      file = await this.openStage(record)
      const digest = await this.verifyChunks(record, file, signal)
      signal.throwIfAborted()
      if (!record.transferComplete && !record.bodyComplete) {
        const fetched = await this.fetch(record, signal)
        response = fetched.response
        if (!response.ok || !response.body)
          throw new RemoteImportError(
            502,
            `Remote download failed (${response.status})`
          )
        if (
          response.headers.get('content-encoding') &&
          !/^identity$/i.test(response.headers.get('content-encoding')!)
        )
          throw new RemoteImportError(
            409,
            'Source sent encoded bytes despite identity encoding; size/range cannot be trusted'
          )
        const length = response.headers.get('content-length'),
          size = length === null ? undefined : Number(length)
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
          throw new RemoteImportError(409, 'Invalid source Content-Length')
        const rawEtag = response.headers.get('etag'),
          etag =
            rawEtag &&
            /^"[\x21\x23-\x7e]*"$/.test(rawEtag) &&
            rawEtag.length <= 1000
              ? rawEtag
              : undefined
        let total = size ?? record.expectedBytes
        if (record.received) {
          const range = response.headers
            .get('content-range')
            ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
          if (
            response.status !== 206 ||
            !range ||
            Number(range[1]) !== record.received ||
            Number(range[3]) !== record.total ||
            Number(range[2]) !== record.total! - 1 ||
            etag !== record.etag ||
            (size !== undefined && size !== record.total! - record.received)
          )
            throw new RemoteImportError(
              409,
              'Source range/size/strong ETag changed; partial data was preserved'
            )
          total = record.total
        } else if (response.status !== 200)
          throw new RemoteImportError(
            409,
            'Initial source must provide a complete 200 representation'
          )
        if (
          (total !== undefined && total > UPLOAD_MAX_BYTES) ||
          (record.expectedBytes !== undefined &&
            total !== undefined &&
            total !== record.expectedBytes)
        )
          throw new RemoteImportError(
            409,
            'Source size differs from the approved bound/expected bytes'
          )
        record = this.update(id, { total, etag, resolvedUrl: fetched.url })
        let offset = record.received,
          pending = Buffer.alloc(UPLOAD_CHUNK_BYTES),
          used = 0,
          received = offset
        for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted()
          received += value.byteLength
          if (
            received > UPLOAD_MAX_BYTES ||
            (total !== undefined && received > total) ||
            (record.expectedBytes !== undefined &&
              received > record.expectedBytes)
          )
            throw new RemoteImportError(
              413,
              'Source exceeded the approved byte bound'
            )
          let position = 0
          while (position < value.byteLength) {
            const count = Math.min(
              UPLOAD_CHUNK_BYTES - used,
              value.byteLength - position
            )
            pending.set(value.subarray(position, position + count), used)
            used += count
            position += count
            if (used === UPLOAD_CHUNK_BYTES) {
              await this.commit(id, file, offset, pending)
              digest.update(pending)
              offset += used
              pending = Buffer.alloc(UPLOAD_CHUNK_BYTES)
              used = 0
              signal.throwIfAborted()
            }
          }
        }
        signal.throwIfAborted()
        if (
          (total !== undefined && received !== total) ||
          (record.expectedBytes !== undefined &&
            received !== record.expectedBytes)
        )
          throw new RemoteImportError(
            409,
            'Remote transfer ended before its expected length'
          )
        if (used) digest.update(pending.subarray(0, used))
        const sha256 = digest.digest('hex')
        if (used)
          await this.commit(id, file, offset, pending.subarray(0, used), {
            bodyComplete: true,
            sha256,
            total: received
          })
        else this.update(id, { bodyComplete: true, sha256, total: received })
        if (record.expectedSha256 && sha256 !== record.expectedSha256)
          throw new RemoteImportError(
            422,
            'Downloaded file does not match the expected SHA-256'
          )
        record = this.update(id, {
          total: received,
          transferComplete: true,
          sha256,
          state: 'publishing'
        })
      } else {
        const sha256 = digest.digest('hex')
        if (
          (record.transferComplete && sha256 !== record.sha256) ||
          (record.expectedSha256 && sha256 !== record.expectedSha256)
        )
          throw new RemoteImportError(
            422,
            'Completed remote bytes differ from their source SHA-256'
          )
        record = this.update(id, {
          transferComplete: true,
          sha256,
          state: 'publishing'
        })
      }
      await file.close()
      file = undefined
      signal.throwIfAborted()
      const destination = await this.destination(record)
      if (
        destination.targetDirectoryIdentity !==
          record.targetDirectoryIdentity ||
        destination.targetDirectory !== record.targetDirectory
      )
        throw new RemoteImportError(
          409,
          'Destination directory changed during download'
        )
      const chunkHashes = this.db
        .prepare('SELECT sha256 FROM chunks WHERE download_id=? ORDER BY idx')
        .all(id)
        .map((row) => String(row.sha256))
      const upload = await this.uploads.adoptDownloaded(
        {
          operationId: `remote-${id}`,
          directory: record.directory,
          name: record.name,
          bytes: record.received,
          chunkHashes,
          expectedSha256: record.sha256
        },
        id
      )
      this.update(id, {
        state: 'completed',
        uploadId: upload.id,
        error: undefined
      })
      await this.removeStage(id)
    } catch (error) {
      if (this.get(id).state === 'completed') {
        this.update(id, {
          error: 'Import committed; private download cleanup remains pending.'
        })
        return
      }
      this.update(id, {
        state: this.closing || signal.aborted ? 'paused' : 'failed',
        error: this.closing
          ? 'Host stopped; resume explicitly.'
          : signal.aborted
            ? 'Download paused; committed chunks remain.'
            : String(error)
                .replace(/https?:\/\/\S+/g, '[source URL]')
                .slice(0, 2000)
      })
    } finally {
      await response?.body?.cancel().catch(() => {})
      await file?.close()
    }
  }
  async pause(id: string): Promise<RemoteImport> {
    const record = this.get(id),
      active = this.tasks.get(id)
    if (record.state === 'publishing')
      throw new RemoteImportError(
        409,
        'Publication is already verifying/committing; wait for its authoritative receipt'
      )
    active?.controller.abort()
    await active?.task
    return this.get(id)
  }
  async cancel(id: string): Promise<RemoteImport> {
    await this.pause(id)
    return this.serial(async () => {
      const record = this.get(id)
      if (record.state === 'completed')
        throw new RemoteImportError(
          409,
          'Completed imports belong to the project; cancellation never deletes them'
        )
      if (record.state === 'canceled') return record
      const linked = this.uploads.byOperation(`remote-${id}`)
      const matches =
        linked &&
        record.transferComplete &&
        linked.bytes === record.received &&
        linked.target === record.target &&
        linked.expectedSha256 === record.sha256 &&
        (linked.state !== 'completed' || linked.sha256 === record.sha256)
      if (linked && !matches) {
        await this.removeStage(id)
        return this.update(id, {
          state: 'canceled',
          error:
            'Conflicting publisher receipt was left untouched; only this download staging was canceled.'
        })
      }
      if (linked && linked.state !== 'completed')
        await this.uploads.cancel(linked.id)
      if (linked?.state === 'completed'){
        this.update(id,{state:'completed',uploadId:linked.id,error:undefined})
        try{await this.removeStage(id)}catch{this.update(id,{error:'Import committed; private download cleanup remains pending.'})}
        return this.get(id)
      }
      await this.removeStage(id)
      return this.update(id, { state: 'canceled', error: undefined })
    })
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.closing = true
    for (const active of this.tasks.values()) active.controller.abort()
    return (this.disposing = (async () => {
      await Promise.allSettled(
        [...this.tasks.values()].map((active) => active.task)
      )
      await this.writes
      this.db.close()
    })())
  }
}
