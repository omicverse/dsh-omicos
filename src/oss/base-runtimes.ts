import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  open,
  mkdir,
  chmod,
  realpath,
  readdir,
  lstat,
  readlink,
  rm
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerEnvironment } from './worker-environment.js'
import {
  normalizeBaseRuntime,
  stageRuntimeArchive
} from './runtime-download.js'
import {
  unpackRuntimeArchive,
  type RuntimeFileManifest
} from './runtime-archive.js'
import { EnvironmentError } from './environment-types.js'
import type {
  BaseRuntimeInstall,
  BaseRuntimeSpec,
  BaseRuntimeSelection
} from './base-runtime-types.js'
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const id = (value: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value))
    throw new EnvironmentError(400, 'Invalid base runtime identity')
  return value
}
class RuntimeBusyError extends EnvironmentError {
  constructor() {
    super(
      409,
      'Another Host owns a base runtime action; finish or cancel it there'
    )
  }
}
const active = new Set(['downloading', 'extracting', 'verifying'])
const supervisor = fileURLToPath(
  new URL('../../runtime/provision_watchdog.cjs', import.meta.url)
)
const PROBE = `import json,sys,os,platform,ssl,sqlite3,zlib,venv,ensurepip
print(json.dumps({'version':platform.python_version(),'implementation':sys.implementation.name,'platform':sys.platform,'arch':platform.machine(),'executable':os.path.realpath(sys.executable),'prefix':os.path.realpath(sys.prefix),'ssl':ssl.OPENSSL_VERSION,'sqlite':sqlite3.sqlite_version,'pip':ensurepip.version()}))`
/** Host-owned Python distribution cache. No automatic selection, package installation or project grants. */
export class BaseRuntimes {
  private task?: Promise<void>
  private activeId?: string
  private controller?: AbortController
  private child?: ChildProcess
  private closing = false
  private disposing?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private selectionPending = 0
  private constructor(
    private db: Database,
    readonly directory: string
  ) {}
  static async open(stateDir: string): Promise<BaseRuntimes> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const canonical = await realpath(stateDir),
      directory = join(canonical, 'python-runtimes')
    await mkdir(directory, { mode: 0o700, recursive: true })
    if ((await realpath(directory)) !== directory)
      throw new EnvironmentError(
        403,
        'Base runtime cache cannot be a symbolic link'
      )
    await chmod(directory, 0o700)
    const file = join(canonical, 'python-runtimes.sqlite'),
      handle = await open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      )
    try {
      if (!(await handle.stat()).isFile())
        throw new EnvironmentError(409, 'Runtime ledger must be a regular file')
    } finally {
      await handle.close()
    }
    await chmod(file, 0o600)
    const db = new DatabaseSync(file)
    try {
      const version = Number(
          db.prepare('PRAGMA user_version').get()!.user_version
        ),
        application = Number(
          db.prepare('PRAGMA application_id').get()!.application_id
        )
      if (
        version > 1 ||
        (application !== 0 && application !== 0x4f425054) ||
        (version && application !== 0x4f425054)
      )
        throw new EnvironmentError(
          409,
          'Unsupported base runtime database; preserve and inspect it'
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
          throw new EnvironmentError(409, 'Unknown base runtime database')
        db.exec(
          `BEGIN IMMEDIATE; CREATE TABLE installs(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE,record_json TEXT NOT NULL); CREATE TABLE selections(revision INTEGER PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL); CREATE TABLE lease(id INTEGER PRIMARY KEY,pid INTEGER,token TEXT); INSERT INTO lease VALUES(1,NULL,NULL); INSERT INTO selections VALUES(1,'{"revision":1,"runtimeId":null,"at":"initial"}'); PRAGMA application_id=${0x4f425054}; PRAGMA user_version=1; COMMIT;`
        )
      }
      const service = new BaseRuntimes(db, directory)
      let release: (() => void) | undefined
      try {
        release = service.acquire()
      } catch (error) {
        if (!(error instanceof RuntimeBusyError)) throw error
      } finally {
        release?.()
      }
      return service
    } catch (error) {
      db.close()
      throw error
    }
  }
  private acquire(): () => void {
    if (this.closing)
      throw new EnvironmentError(503, 'Base runtime manager is closing')
    this.db.exec('BEGIN IMMEDIATE')
    const token = randomUUID()
    try {
      const row = this.db.prepare('SELECT pid FROM lease WHERE id=1').get()
      if (!row)
        throw new EnvironmentError(409, 'Runtime ownership ledger is missing')
      if (row.pid !== null) {
        let alive = true
        try {
          process.kill(Number(row.pid), 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
        }
        if (alive) throw new RuntimeBusyError()
      }
      this.db
        .prepare('UPDATE lease SET pid=?,token=? WHERE id=1')
        .run(process.pid, token)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.db
        .prepare(
          'UPDATE lease SET pid=NULL,token=NULL WHERE id=1 AND pid=? AND token=?'
        )
        .run(process.pid, token)
    }
    try {
      for (;;) {
        const rows = this.db
          .prepare(
            "SELECT id FROM installs WHERE json_extract(record_json,'$.state') IN ('downloading','extracting','verifying') LIMIT 50"
          )
          .all()
        if (!rows.length) break
        for (const row of rows)
          this.update(String(row.id), {
            state: 'interrupted',
            error:
              'Previous runtime owner stopped; no automatic execution or resume is performed.'
          })
      }
    } catch (error) {
      release()
      throw error
    }
    return release
  }
  private path(value: string) {
    return join(this.directory, id(value))
  }
  private async safe(value: string) {
    const path = this.path(value)
    if ((await realpath(path)) !== path)
      throw new EnvironmentError(409, 'Runtime installation path changed')
    return path
  }
  get(value: string): BaseRuntimeInstall {
    id(value)
    const row = this.db
      .prepare('SELECT record_json FROM installs WHERE id=?')
      .get(value)
    if (!row) throw new EnvironmentError(404, 'Base Python runtime not found')
    const record = JSON.parse(String(row.record_json)) as BaseRuntimeInstall
    const spec = normalizeBaseRuntime(record.spec)
    if (
      record.requestSha256 !== hash(JSON.stringify(spec)) ||
      record.id !== value ||
      record.interpreter !== join(this.path(value), 'payload', spec.entrypoint)
    )
      throw new EnvironmentError(409, 'Persisted base runtime identity changed')
    return record
  }
  private update(value: string, fields: Partial<BaseRuntimeInstall>) {
    const record = {
      ...this.get(value),
      ...fields,
      updatedAt: new Date().toISOString()
    }
    this.db
      .prepare('UPDATE installs SET record_json=? WHERE id=?')
      .run(JSON.stringify(record), value)
    return record
  }
  selection(): BaseRuntimeSelection {
    const row = this.db
        .prepare(
          'SELECT revision,record_json FROM selections ORDER BY revision DESC LIMIT 1'
        )
        .get()!,
      value = JSON.parse(String(row.record_json)) as BaseRuntimeSelection
    if (
      value.revision !== Number(row.revision) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !(
        value.runtimeId === null ||
        (typeof value.runtimeId === 'string' &&
          /^[a-zA-Z0-9_-]{1,150}$/.test(value.runtimeId))
      )
    )
      throw new EnvironmentError(409, 'Invalid base runtime selection')
    return value
  }
  list(before = Number.MAX_SAFE_INTEGER) {
    if (
      !this.task &&
      this.db
        .prepare(
          "SELECT id FROM installs WHERE json_extract(record_json,'$.state') IN ('downloading','extracting','verifying') LIMIT 1"
        )
        .get()
    ) {
      try {
        this.acquire()()
      } catch (error) {
        if (!(error instanceof RuntimeBusyError)) throw error
      }
    }
    if (!Number.isSafeInteger(before) || before < 1)
      throw new EnvironmentError(400, 'Invalid base runtime cursor')
    const rows = this.db
      .prepare(
        'SELECT rowid,id FROM installs WHERE rowid<? ORDER BY rowid DESC LIMIT 51'
      )
      .all(before)
    return {
      entries: rows.slice(0, 50).map((row) => {
        const value = this.get(String(row.id))
        return {
          id: value.id,
          title: value.spec.title,
          version: value.spec.version,
          platform: value.spec.platform,
          arch: value.spec.arch,
          state: value.state,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          downloaded: value.downloaded,
          bytes: value.spec.bytes,
          error: value.error
        }
      }),
      selection: this.selection(),
      next: rows.length > 50 ? Number(rows[49].rowid) : undefined,
      platform: process.platform,
      arch: process.arch,
      installSupported: ['darwin', 'linux'].includes(process.platform)
    }
  }
  history(before = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(before) || before < 1)
      throw new EnvironmentError(400, 'Invalid base runtime history cursor')
    const rows = this.db
      .prepare(
        'SELECT revision,record_json FROM selections WHERE revision<? ORDER BY revision DESC LIMIT 51'
      )
      .all(before)
    return {
      entries: rows
        .slice(0, 50)
        .map(
          (row) => JSON.parse(String(row.record_json)) as BaseRuntimeSelection
        ),
      next: rows.length > 50 ? Number(rows[49].revision) : undefined
    }
  }
  start(specInput: BaseRuntimeSpec, operationId: string): BaseRuntimeInstall {
    if (this.closing)
      throw new EnvironmentError(503, 'Base runtime manager is closing')
    id(operationId)
    const spec = normalizeBaseRuntime(specInput)
    if (spec.platform !== process.platform || spec.arch !== process.arch)
      throw new EnvironmentError(
        400,
        'Runtime descriptor does not match this Host platform/architecture'
      )
    this.list()
    const requestSha256 = hash(JSON.stringify(spec)),
      previous = this.db
        .prepare('SELECT id FROM installs WHERE operation_id=?')
        .get(operationId)
    if (previous) {
      const record = this.get(String(previous.id))
      if (record.requestSha256 !== requestSha256)
        throw new EnvironmentError(
          409,
          'Runtime operation belongs to another descriptor'
        )
      return record
    }
    if (this.task || this.selectionPending)
      throw new EnvironmentError(
        409,
        'Another runtime action is still finishing'
      )
    if (
      Number(this.db.prepare('SELECT COUNT(*) AS n FROM installs').get()!.n) >=
      100
    )
      throw new EnvironmentError(
        409,
        'Base runtime receipt limit reached; preserve and review installation history'
      )
    const value = randomUUID(),
      at = new Date().toISOString(),
      record: BaseRuntimeInstall = {
        id: value,
        operationId,
        requestSha256,
        spec,
        state: 'downloading',
        createdAt: at,
        updatedAt: at,
        downloaded: 0,
        interpreter: join(this.path(value), 'payload', spec.entrypoint)
      }
    const release = this.acquire()
    const existing = this.db
      .prepare('SELECT id FROM installs WHERE operation_id=?')
      .get(operationId)
    if (existing) {
      release()
      const replay = this.get(String(existing.id))
      if (replay.requestSha256 !== requestSha256)
        throw new EnvironmentError(
          409,
          'Runtime operation belongs to another descriptor'
        )
      return replay
    }
    try {
      if (
        Number(
          this.db.prepare('SELECT COUNT(*) AS n FROM installs').get()!.n
        ) >= 100
      )
        throw new EnvironmentError(409, 'Base runtime receipt limit reached')
      this.db
        .prepare('INSERT INTO installs VALUES(?,?,?)')
        .run(value, operationId, JSON.stringify(record))
    } catch (error) {
      release()
      throw error
    }
    const controller = new AbortController()
    this.controller = controller
    this.activeId = value
    const task = this.install(
      record,
      AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)])
    )
    this.task = task
    void task
      .finally(() => {
        if (this.task === task) {
          this.task = undefined
          this.controller = undefined
          this.activeId = undefined
        }
        release()
      })
      .catch(() => {})
    return record
  }
  private async probe(
    record: BaseRuntimeInstall,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    const env = workerEnvironment(process.env)
    for (const name of Object.keys(env))
      if (/^(PYTHON|VIRTUAL_ENV|CONDA_|R_|LD_|DYLD_)/i.test(name))
        delete env[name]
    env.PYTHONDONTWRITEBYTECODE = '1'
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    return new Promise((resolve, reject) => {
      let output = '',
        stderr = '',
        status = '',
        failure: Error | undefined
      const child = spawn(
        process.execPath,
        [supervisor, record.interpreter, '-I', '-S', '-B', '-c', PROBE],
        {
          cwd: this.path(record.id),
          detached: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
        }
      )
      this.child = child
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            failure = error as Error
        }
      }
      const abort = () => {
        failure = new EnvironmentError(409, 'Runtime verification canceled')
        kill()
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const timer = setTimeout(() => {
        failure = new EnvironmentError(408, 'Runtime verification timed out')
        kill()
      }, 30000)
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
        if (output.length > 32000) {
          failure = new EnvironmentError(
            413,
            'Runtime verification output exceeded its limit'
          )
          kill()
        }
      })
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4000)
      })
      child.stdio[3]?.on('data', (chunk) => {
        status = (status + String(chunk)).slice(-16000)
      })
      child.once('error', (error) => {
        failure = error
      })
      child.once('close', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (this.child === child) this.child = undefined
        if (failure) return reject(failure)
        try {
          const exit = JSON.parse(status)
          if (exit.code !== 0)
            throw Error(
              'Downloaded Python did not verify successfully: ' + stderr
            )
          const result = JSON.parse(output)
          const arch =
            result.arch === 'aarch64' || result.arch === 'arm64'
              ? 'arm64'
              : result.arch === 'x86_64' || result.arch === 'AMD64'
                ? 'x64'
                : result.arch
          if (
            result.version !== record.spec.version ||
            result.implementation !== 'cpython' ||
            result.platform !== record.spec.platform ||
            arch !== record.spec.arch ||
            typeof result.executable !== 'string' ||
            !result.executable.startsWith(
              join(this.path(record.id), 'payload', 'python') + sep
            ) ||
            typeof result.prefix !== 'string' ||
            !result.prefix.startsWith(
              join(this.path(record.id), 'payload') + sep
            )
          )
            throw Error(
              'Downloaded interpreter identity/platform/prefix differs from its descriptor'
            )
          resolve(result)
        } catch (error) {
          reject(new EnvironmentError(409, String(error).slice(0, 1000)))
        }
      })
    })
  }
  private async install(
    record: BaseRuntimeInstall,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const directory = this.path(record.id)
      await mkdir(directory, { mode: 0o700 })
      await this.safe(record.id)
      const archive = join(directory, 'archive.tar.gz')
      let last = 0
      await stageRuntimeArchive(record.spec, archive, signal, (bytes) => {
        if (bytes - last >= 1024 * 1024 || bytes === record.spec.bytes) {
          last = bytes
          this.update(record.id, { downloaded: bytes })
        }
      })
      signal.throwIfAborted()
      this.update(record.id, { state: 'extracting' })
      const payload = join(directory, 'payload')
      await mkdir(payload, { mode: 0o700 })
      const manifest = await unpackRuntimeArchive(
        record.spec,
        archive,
        payload,
        signal
      )
      signal.throwIfAborted()
      this.update(record.id, { state: 'verifying' })
      const probe = await this.probe(record, signal)
      signal.throwIfAborted()
      const encoded = JSON.stringify(manifest)
      const file = await open(join(directory, 'manifest.json'), 'wx', 0o600)
      try {
        await file.writeFile(encoded)
        await file.sync()
      } finally {
        await file.close()
      }
      this.update(record.id, {
        manifestSha256: hash(encoded),
        files: manifest.entries.length,
        unpackedBytes: manifest.bytes,
        probe
      })
      await this.inspect(record.id, true)
      signal.throwIfAborted()
      this.update(record.id, { state: 'ready', error: undefined })
    } catch (error) {
      this.update(record.id, {
        state: this.closing
          ? 'interrupted'
          : this.controller?.signal.aborted
            ? 'canceled'
            : 'failed',
        error: String(error).slice(0, 2000)
      })
    }
  }
  async verify(value: string): Promise<BaseRuntimeInstall> {
    return this.inspect(value)
  }
  private async inspect(
    value: string,
    verifying = false
  ): Promise<BaseRuntimeInstall> {
    if (this.closing)
      throw new EnvironmentError(503, 'Base runtime manager is closing')
    const record = this.get(value)
    if (
      (record.state !== 'ready' &&
        !(verifying && record.state === 'verifying')) ||
      !record.manifestSha256
    )
      throw new EnvironmentError(409, 'Base runtime is not ready')
    const directory = await this.safe(value),
      payload = join(directory, 'payload')
    if ((await realpath(payload)) !== payload)
      throw new EnvironmentError(409, 'Runtime payload path changed')
    const manifestFile = await open(
      join(directory, 'manifest.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    let encoded: string
    try {
      const status = await manifestFile.stat()
      if (!status.isFile() || status.size > 10000000)
        throw new EnvironmentError(
          409,
          'Runtime manifest is not a bounded regular file'
        )
      encoded = await manifestFile.readFile('utf8')
    } finally {
      await manifestFile.close()
    }
    if (hash(encoded) !== record.manifestSha256)
      throw new EnvironmentError(409, 'Runtime file manifest changed')
    const manifest = JSON.parse(encoded) as RuntimeFileManifest
    if (
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > 40000 ||
      manifest.entrypoint !== record.spec.entrypoint
    )
      throw new EnvironmentError(409, 'Invalid runtime file manifest')
    const expected = new Map(
      manifest.entries.map((entry) => [entry.path, entry])
    )
    let seen = 0
    const walk = async (relative: string) => {
      for (const entry of await readdir(join(payload, relative), {
        withFileTypes: true
      })) {
        if (this.closing)
          throw new EnvironmentError(503, 'Base runtime manager is closing')
        if (++seen > 40000)
          throw new EnvironmentError(409, 'Runtime file inventory grew')
        const name = relative ? relative + '/' + entry.name : entry.name,
          record = expected.get(name)
        if (!record)
          throw new EnvironmentError(
            409,
            'Unexpected file in immutable base runtime'
          )
        expected.delete(name)
        const file = join(payload, name),
          status = await lstat(file)
        if (record.type === 'directory') {
          if (
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            (status.mode & 0o777) !== record.mode
          )
            throw new EnvironmentError(409, 'Runtime directory changed')
          await walk(name)
        } else if (record.type === 'symlink') {
          if (
            !status.isSymbolicLink() ||
            (await readlink(file)) !== record.target
          )
            throw new EnvironmentError(409, 'Runtime link changed')
          const actual = await realpath(file)
          if (
            actual !== join(payload, 'python') &&
            !actual.startsWith(join(payload, 'python') + sep)
          )
            throw new EnvironmentError(409, 'Runtime link escaped')
        } else {
          if (
            !status.isFile() ||
            status.size !== record.bytes ||
            (status.mode & 0o777) !== record.mode
          )
            throw new EnvironmentError(409, 'Runtime file identity changed')
          const digest = createHash('sha256')
          for await (const chunk of (
            await open(
              file,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            )
          ).createReadStream()) {
            if (this.closing)
              throw new EnvironmentError(503, 'Base runtime manager is closing')
            digest.update(chunk)
          }
          if (digest.digest('hex') !== record.sha256)
            throw new EnvironmentError(409, 'Runtime file content changed')
        }
      }
    }
    await walk('')
    if (expected.size)
      throw new EnvironmentError(409, 'Runtime files are missing')
    return record
  }
  async selectedInterpreter(): Promise<string | undefined> {
    const selected = this.selection()
    return selected.runtimeId
      ? (await this.verify(selected.runtimeId)).interpreter
      : undefined
  }
  select(input: {
    operationId: string
    revision: number
    runtimeId: string | null
  }): Promise<BaseRuntimeSelection> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return Promise.reject(
        new EnvironmentError(400, 'An explicit runtime selection is required')
      )
    if (this.closing)
      throw new EnvironmentError(503, 'Base runtime manager is closing')
    this.selectionPending++
    const task = this.writes.then(async () => {
      id(input.operationId)
      if (
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1 ||
        (input.runtimeId !== null && typeof input.runtimeId !== 'string')
      )
        throw new EnvironmentError(
          400,
          'Current runtime selection revision is required'
        )
      const request = hash(
        JSON.stringify({
          operationId: input.operationId,
          revision: input.revision,
          runtimeId: input.runtimeId
        })
      )
      const replay = (): BaseRuntimeSelection | undefined => {
        const prior = this.db
          .prepare('SELECT request_hash FROM operations WHERE id=?')
          .get(input.operationId)
        if (prior) {
          if (prior.request_hash !== request)
            throw new EnvironmentError(
              409,
              'Selection operation belongs to another request'
            )
          const saved = this.db
            .prepare(
              "SELECT record_json FROM selections WHERE json_extract(record_json,'$.operationId')=?"
            )
            .get(input.operationId)
          if (!saved)
            throw new EnvironmentError(
              409,
              'Selection replay receipt is missing'
            )
          return JSON.parse(String(saved.record_json)) as BaseRuntimeSelection
        }
        return undefined
      }
      const saved = replay()
      if (saved) return saved
      if (this.task)
        throw new EnvironmentError(
          409,
          'Runtime installation is still finishing'
        )
      const release = this.acquire()
      try {
        const saved = replay()
        if (saved) return saved
        if (input.runtimeId !== null) await this.verify(input.runtimeId)
        if (this.closing)
          throw new EnvironmentError(503, 'Base runtime manager is closing')
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const current = this.selection()
          if (current.revision !== input.revision)
            throw new EnvironmentError(
              409,
              'Runtime selection changed; refresh before selecting'
            )
          const selected: BaseRuntimeSelection = {
            revision: current.revision + 1,
            runtimeId: input.runtimeId,
            operationId: input.operationId,
            at: new Date().toISOString()
          }
          this.db
            .prepare('INSERT INTO selections VALUES(?,?)')
            .run(selected.revision, JSON.stringify(selected))
          this.db
            .prepare('INSERT INTO operations VALUES(?,?)')
            .run(input.operationId, request)
          this.db.exec('COMMIT')
          return selected
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      } finally {
        release()
      }
    })
    this.writes = task.catch(() => {})
    void task.finally(() => this.selectionPending--).catch(() => {})
    return task
  }
  async cancel(value: string) {
    this.list()
    const record = this.get(value)
    if (!active.has(record.state)) return record
    if (!this.controller || this.activeId !== value)
      throw new EnvironmentError(
        409,
        'This installation is owned by another Host; cancel it there'
      )
    this.controller.abort(new Error('Owner canceled runtime installation'))
    await this.task
    return this.get(value)
  }
  removePartial(value: string): Promise<BaseRuntimeInstall> {
    if (this.closing)
      return Promise.reject(
        new EnvironmentError(503, 'Base runtime manager is closing')
      )
    const task = this.writes.then(async () => {
      const record = this.get(value)
      if (record.state === 'removed') return record
      if (
        this.task ||
        this.selection().runtimeId === value ||
        !['failed', 'canceled', 'interrupted'].includes(record.state)
      )
        throw new EnvironmentError(
          409,
          'Only inactive partial runtimes can be removed'
        )
      const release = this.acquire()
      try {
        try {
          await this.safe(value)
          await rm(this.path(value), { recursive: true, force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        return this.update(value, { state: 'removed' })
      } finally {
        release()
      }
    })
    this.writes = task.catch(() => {})
    return task
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.closing = true
    this.controller?.abort(new Error('Host stopped'))
    return (this.disposing = (async () => {
      try {
        await this.task
        await this.writes
      } finally {
        this.db.close()
      }
    })())
  }
}
