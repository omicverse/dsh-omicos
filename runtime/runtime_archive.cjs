/** Private staging only. Archive data is never executed here; worker threads are not an OS sandbox. */
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createGunzip } = require('node:zlib')
const { Transform } = require('node:stream')
const { Parser } = require('tar')
const MAX_RAW = 2 * 1024 ** 3,
  MAX_FILE = 256 * 1024 ** 2,
  MAX_ENTRIES = 20000
const root = workerData.destination,
  records = [],
  links = [],
  known = new Map()
let raw = 0,
  regularBytes = 0,
  count = 0,
  meta = 0
function name(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2000 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /[\x00-\x20\x7f-\uffff:]/.test(value)
  )
    throw Error('Unsafe/non-ASCII runtime archive path')
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/\/+$/, '')
  const parts = value.split('/')
  if (
    parts[0] !== 'python' ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        !/^[A-Za-z0-9_.+@(),=-]+$/.test(part)
    )
  )
    throw Error(
      'Runtime archive entries must stay within explicit python/ paths'
    )
  return value
}
function reserve(value, type, explicit) {
  if (known.size >= 40000)
    throw Error('Runtime archive exceeds 40000 total paths')
  const key = value.toLowerCase(),
    old = known.get(key)
  if (
    old &&
    (old.path !== value || old.type !== type || (explicit && old.explicit))
  )
    throw Error('Duplicate, case-alias or conflicting runtime archive path')
  known.set(key, {
    path: value,
    type,
    explicit: explicit || old?.explicit || false
  })
}
async function parents(value) {
  let relative = ''
  for (const part of value.split('/').slice(0, -1)) {
    relative = relative ? relative + '/' + part : part
    reserve(relative, 'directory', false)
    const absolute = path.join(root, relative)
    try {
      await fsp.mkdir(absolute, { mode: 0o700 })
      await fsp.chmod(absolute, 0o700)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const status = await fsp.lstat(absolute)
      if (!status.isDirectory() || status.isSymbolicLink())
        throw Error('Runtime entry parent is not a private directory')
    }
  }
}
async function fileRecord(relative) {
  const absolute = path.join(root, relative),
    status = await fsp.lstat(absolute)
  if (!status.isFile() || status.size > MAX_FILE)
    throw Error('Invalid runtime file')
  const hash = createHash('sha256')
  const input = fs.createReadStream(absolute, {
    flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    highWaterMark: 65536
  })
  for await (const chunk of input) hash.update(chunk)
  return {
    path: relative,
    type: 'file',
    bytes: status.size,
    mode: status.mode & 0o777,
    sha256: hash.digest('hex')
  }
}
async function main() {
  if (
    (await fsp.realpath(root)) !== root ||
    !(await fsp.lstat(root)).isDirectory() ||
    (await fsp.readdir(root)).length
  )
    throw Error(
      'Runtime extraction requires an empty canonical private directory'
    )
  await fsp.chmod(root, 0o700)
  const archive = await fsp.open(
    workerData.archive,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  )
  const status = await archive.stat()
  if (!status.isFile() || status.size !== workerData.bytes)
    throw Error('Runtime archive size changed')
  const hash = createHash('sha256')
  let compressed = 0
  const input = archive.createReadStream({
    autoClose: false,
    highWaterMark: 65536
  })
  const checkCompressed = new Transform({
    transform(chunk, _encoding, done) {
      compressed += chunk.length
      if (compressed > workerData.bytes)
        return done(Error('Runtime archive grew'))
      hash.update(chunk)
      done(null, chunk)
    }
  })
  let initial = Buffer.alloc(0),
    checked = false
  const budget = new Transform({
    transform(chunk, _encoding, done) {
      raw += chunk.length
      if (raw > MAX_RAW)
        return done(Error('Runtime archive exceeds 2 GiB decompressed'))
      if (!checked) {
        initial = Buffer.concat([initial, chunk])
        if (initial.length < 4) return done()
        checked = true
        if (
          (initial[0] === 0x1f && initial[1] === 0x8b) ||
          initial.readUInt32LE(0) === 0xfd2fb528
        )
          return done(
            Error('Nested runtime archive compression is unsupported')
          )
        done(null, initial)
        initial = Buffer.alloc(0)
      } else done(null, chunk)
    }
  })
  const unzip = createGunzip()
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: 65536,
    maxDecompressionRatio: 1000,
    brotli: false,
    zstd: false
  })
  let failure,
    tail = Promise.resolve()
  const pending = new Set(),
    entries = new Set()
  const stop = (error) => {
    if (failure) return
    failure = error
    for (const entry of entries) entry.destroy(error)
    input.destroy()
    checkCompressed.destroy()
    unzip.destroy()
    budget.destroy()
    parser.abort(error)
  }
  const processEntry = async (entry) => {
    const relative = name(entry.path)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw Error('Invalid runtime entry size')
    const type =
      entry.type === 'File' || entry.type === 'OldFile'
        ? 'file'
        : entry.type === 'Directory'
          ? 'directory'
          : entry.type === 'SymbolicLink'
            ? 'symlink'
            : entry.type === 'Link'
              ? 'hardlink'
              : undefined
    if (!type) throw Error('Unsupported runtime archive entry type')
    if (type !== 'file' && entry.size !== 0)
      throw Error('Non-file runtime entry has a body')
    await parents(relative)
    reserve(relative, type, true)
    if (type === 'directory') {
      try {
        await fsp.mkdir(path.join(root, relative), { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      await fsp.chmod(path.join(root, relative), 0o700)
      entry.resume()
      return
    }
    if (type === 'symlink' || type === 'hardlink') {
      if (
        relative === 'python' ||
        typeof entry.linkpath !== 'string' ||
        entry.linkpath.length > 2000 ||
        entry.linkpath.includes('\\') ||
        path.posix.isAbsolute(entry.linkpath) ||
        /[\x00-\x20\x7f-\uffff:]/.test(entry.linkpath)
      )
        throw Error('Unsafe runtime link target')
      const lexical =
        type === 'hardlink'
          ? name(entry.linkpath)
          : path.posix.normalize(
              path.posix.join(path.posix.dirname(relative), entry.linkpath)
            )
      if (lexical !== 'python' && !lexical.startsWith('python/'))
        throw Error('Runtime link escapes its installation')
      links.push({ path: relative, type, target: entry.linkpath, lexical })
      entry.resume()
      return
    }
    if (entry.size > MAX_FILE || (regularBytes += entry.size) > MAX_RAW)
      throw Error('Runtime file budget exceeded')
    const file = await fsp.open(
      path.join(root, relative),
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    )
    let bytes = 0
    const digest = createHash('sha256')
    try {
      for await (const chunk of entry) {
        bytes += chunk.length
        if (bytes > entry.size)
          throw Error('Runtime entry exceeded declared size')
        digest.update(chunk)
        let offset = 0
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset)
          if (!result.bytesWritten)
            throw Error('Runtime file write made no progress')
          offset += result.bytesWritten
        }
      }
      if (bytes !== entry.size) throw Error('Incomplete runtime file')
      await file.chmod(entry.mode & 0o111 ? 0o700 : 0o600)
    } finally {
      await file.close()
    }
    records.push({
      path: relative,
      type: 'file',
      bytes,
      mode: entry.mode & 0o111 ? 0o700 : 0o600,
      sha256: digest.digest('hex')
    })
  }
  parser.on('entry', (entry) => {
    entry.pause()
    entry.on('error', () => {})
    entries.add(entry)
    if (++count > MAX_ENTRIES) {
      stop(Error('Runtime archive exceeds 20000 entries'))
      return
    }
    const task = tail
      .then(() => {
        if (failure) {
          entry.destroy()
          return
        }
        return processEntry(entry)
      })
      .catch(stop)
    tail = task
    pending.add(task)
    void task.finally(() => {
      pending.delete(task)
      entries.delete(entry)
    })
  })
  parser.on('ignoredEntry', () =>
    stop(Error('Ignored/unsupported runtime archive entry'))
  )
  parser.on('meta', (value) => {
    meta += Buffer.byteLength(value)
    if (meta > 32 * 1024 ** 2)
      stop(Error('Runtime archive metadata exceeds 32 MiB'))
  })
  try {
    await new Promise((resolve, reject) => {
      for (const stream of [input, checkCompressed, unzip, budget, parser])
        stream.once('error', (error) => {
          stop(error)
          reject(error)
        })
      parser.once('end', resolve)
      input.pipe(checkCompressed).pipe(unzip).pipe(budget).pipe(parser)
    })
    await Promise.all(pending)
    if (failure) throw failure
    if (
      compressed !== workerData.bytes ||
      hash.digest('hex') !== workerData.sha256
    )
      throw Error('Runtime archive SHA-256 changed during extraction')
    let unresolved = [...links]
    while (unresolved.length) {
      const next = []
      let progress = false
      for (const link of unresolved) {
        const target =
          link.type === 'symlink'
            ? root + '/' + path.posix.dirname(link.path) + '/' + link.target
            : path.join(root, link.lexical)
        let actual
        try {
          actual = await fsp.realpath(target)
        } catch (error) {
          if (error.code === 'ENOENT') {
            next.push(link)
            continue
          }
          throw error
        }
        if (
          actual !== path.join(root, 'python') &&
          !actual.startsWith(path.join(root, 'python') + path.sep)
        )
          throw Error('Runtime link resolves outside its installation')
        const destination = path.join(root, link.path)
        if (link.type === 'symlink') {
          await fsp.symlink(link.target, destination)
          records.push({
            path: link.path,
            type: 'symlink',
            target: link.target
          })
        } else {
          const status = await fsp.lstat(actual)
          if (!status.isFile() || (regularBytes += status.size) > MAX_RAW)
            throw Error('Runtime hardlink target/budget is invalid')
          await fsp.copyFile(actual, destination, fs.constants.COPYFILE_EXCL)
          await fsp.chmod(destination, status.mode & 0o111 ? 0o700 : 0o600)
          records.push(await fileRecord(link.path))
        }
        progress = true
      }
      if (!progress) throw Error('Runtime link cycle or missing target')
      unresolved = next
    }
    const interpreter = path.join(root, name(workerData.entrypoint)),
      resolved = await fsp.realpath(interpreter)
    if (
      !resolved.startsWith(root + path.sep) ||
      !(await fsp.stat(resolved)).isFile() ||
      !((await fsp.stat(resolved)).mode & 0o100)
    )
      throw Error('Runtime entrypoint is not a contained executable file')
    for (const value of known.values())
      if (value.type === 'directory')
        records.push({ path: value.path, type: 'directory', mode: 0o700 })
    return {
      entries: records.sort((a, b) => a.path.localeCompare(b.path)),
      bytes: regularBytes,
      entrypoint: workerData.entrypoint
    }
  } finally {
    input.destroy()
    checkCompressed.destroy()
    unzip.destroy()
    budget.destroy()
    for (const entry of entries) entry.destroy()
    await Promise.allSettled([...pending])
    await archive.close()
  }
}
main().then(
  (manifest) => parentPort.postMessage({ ok: true, manifest }),
  (error) => {
    parentPort.postMessage({
      ok: false,
      error: String(error.message || error).slice(0, 2000)
    })
  }
)
