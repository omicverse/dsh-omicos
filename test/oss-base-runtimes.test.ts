import { randomUUID, createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseRuntimes } from '../src/oss/base-runtimes.js'
import { OssRuntime } from '../src/oss/runtime.js'
import type { BaseRuntimeSpec } from '../src/oss/base-runtime-types.js'
const official: BaseRuntimeSpec = {
  schema: 'omicos.python-runtime/1',
  title: 'CPython 3.12.15 · python-build-standalone 20261021',
  version: '3.12.15',
  platform: 'darwin',
  arch: 'arm64',
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-aarch64-apple-darwin-install_only.tar.gz',
  allowedOrigins: [
    'https://github.com',
    'https://release-assets.githubusercontent.com'
  ],
  sha256: 'a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584',
  bytes: 25158763,
  entrypoint: 'python/bin/python3.12',
  license: {
    id: 'Python-2.0 and bundled component licenses',
    url: 'https://gregoryszorc.com/docs/python-build-standalone/main/distributions.html'
  }
}
it('persists owner selection revisions and rejects stale or conflicting replay without running Python', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oss-base-ledger-'))
  const a = await BaseRuntimes.open(root),
    b = await BaseRuntimes.open(root)
  try {
    expect(a.selection().revision).toBe(1)
    const saved = await a.select({
      operationId: 'reset',
      revision: 1,
      runtimeId: null
    })
    expect(saved.revision).toBe(2)
    await expect(
      b.select({ operationId: 'stale', revision: 1, runtimeId: null })
    ).rejects.toMatchObject({ status: 409 })
    await b.select({ operationId: 'newer', revision: 2, runtimeId: null })
    expect(
      await a.select({ operationId: 'reset', revision: 1, runtimeId: null })
    ).toEqual(saved)
    expect(a.selection().revision).toBe(3)
    await expect(
      a.select({ operationId: 'reset', revision: 2, runtimeId: null })
    ).rejects.toMatchObject({ status: 409 })
    expect(a.history().entries).toHaveLength(3)
    expect(() =>
      a.start(
        {
          ...official,
          platform: process.platform === 'darwin' ? 'linux' : 'darwin'
        },
        'wrong-platform'
      )
    ).toThrow(/does not match/)
  } finally {
    await a.dispose()
    await b.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
it.skipIf(process.env.OMICOS_RUNTIME_ONLINE !== '1')(
  'downloads, verifies and boots the exact independent CPython distribution, preserving it through an actual analysis',
  async () => {
    const root =
      process.env.OMICOS_RUNTIME_QA_DIR ||
      (await mkdtemp(join(tmpdir(), 'oss-native-python-')))
    const manager = await BaseRuntimes.open(root)
    try {
      const record = manager.start(
        official,
        'official-' +
          createHash('sha256')
            .update(JSON.stringify(official))
            .digest('hex')
            .slice(0, 32)
      )
      let latest = record
      while (
        ['downloading', 'extracting', 'verifying'].includes(latest.state)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        latest = manager.get(record.id)
      }
      expect(latest.error).toBeUndefined()
      expect(latest.state).toBe('ready')
      expect(latest.probe?.version).toBe('3.12.15')
      await manager.verify(record.id)
      if (manager.selection().runtimeId !== record.id)
        await manager.select({
          operationId: `select-official-${manager.selection().revision}`,
          revision: manager.selection().revision,
          runtimeId: record.id
        })
      await manager.dispose()
      const host = await OssRuntime.open({ stateDir: root })
      try {
        expect(host.python).toBe(record.interpreter)
        expect(host.baseRuntimeError).toBeUndefined()
        const project = await host.project(join(root, 'research'))
        const job = await project.submit(
          'import sys; assert sys.flags.isolated; print(6 * 7)',
          randomUUID(),
          'test:bootstrap'
        )
        let done = project.get(job.id)!
        while (['queued', 'running'].includes(done.state)) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          done = project.get(job.id)!
        }
        expect(done.state).toBe('succeeded')
        expect(done.output).toContain('42')
        const envs = await host.managedEnvironments(project.workspace)
        let env = envs.start({
          operationId: 'base-venv',
          title: 'Native base venv',
          packages: []
        })
        while (['preparing', 'installing', 'verifying'].includes(env.state)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          env = envs.get(env.id)
        }
        expect(env.error).toBeUndefined()
        expect(env.state).toBe('ready')
        await host.baseRuntimes.verify(record.id)
      } finally {
        await host.dispose()
      }
      const marker = join(
        record.interpreter,
        '..',
        '..',
        'unexpected-runtime-file.txt'
      )
      await appendFile(marker, 'drift')
      let blocked: OssRuntime | undefined
      try {
        blocked = await OssRuntime.open({ stateDir: root })
        expect(blocked.baseRuntimeError).toMatch(/Unexpected file/)
        const project = await blocked.project(join(root, 'blocked-research'))
        await expect(
          project.submit('print(42)', 'blocked-drift', 'test')
        ).rejects.toThrow(/unavailable/)
        expect(project.kernelState().state).toBe('cold')
        const envs = await blocked.managedEnvironments(project.workspace)
        expect(() =>
          envs.start({
            operationId: 'no-fallback-venv',
            title: 'must not create',
            packages: []
          })
        ).toThrow(/unavailable/)
        expect(envs.list().entries).toEqual([])
        await blocked.baseRuntimes.select({
          operationId: randomUUID(),
          revision: blocked.baseRuntimes.selection().revision,
          runtimeId: null
        })
        expect(project.executionUnavailable).toBeTruthy()
      } finally {
        await blocked?.dispose()
        await rm(marker, { force: true })
      }
    } finally {
      await manager.dispose()
      if (!process.env.OMICOS_RUNTIME_QA_DIR)
        await rm(root, { recursive: true, force: true })
    }
  },
  300000
)
it('holds installation ownership across Host instances, supports exact retry and cancellation, and retains cleanup receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oss-base-owner-'))
  const a = await BaseRuntimes.open(root)
  let b: BaseRuntimes | undefined
  try {
    const spec = {
      ...official,
      platform: process.platform as 'darwin' | 'linux',
      arch: process.arch as 'arm64' | 'x64',
      archiveFile: join(root, 'missing.tar.gz')
    }
    const first = a.start(spec, 'install')
    b = await BaseRuntimes.open(root)
    expect(b.get(first.id).state).not.toBe('interrupted')
    expect(a.start(spec, 'install').id).toBe(first.id)
    expect(() => a.start({ ...spec, title: 'changed' }, 'install')).toThrow(
      /another descriptor/
    )
    // The missing file can finish before a second Host opens. A foreign cancellation never targets a different local action.
    const foreign = b.get(first.id)
    if (['downloading', 'extracting', 'verifying'].includes(foreign.state)) {
      expect(() => b!.start(spec, 'other')).toThrow(/another Host|Another Host/)
      await expect(b.cancel(first.id)).rejects.toMatchObject({ status: 409 })
    }
    const canceled = await a.cancel(first.id)
    expect(['canceled', 'failed']).toContain(canceled.state)
    expect(a.selection().runtimeId).toBeNull()
    expect((await a.removePartial(first.id)).state).toBe('removed')
    expect(a.get(first.id).spec.sha256).toBe(spec.sha256)
    expect(a.start(spec, 'install').state).toBe('removed')
    expect(a.list().entries).toHaveLength(1)
  } finally {
    await a.dispose()
    await b?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
it.skipIf(process.platform === 'win32')(
  'rejects takeover during a real owned verification process and waits for its exit before partial cleanup',
  async () => {
    const { Header } = await import('tar')
    const { gzipSync } = await import('node:zlib')
    const { createHash } = await import('node:crypto')
    const { writeFile, stat } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'oss-base-process-'))
    const a = await BaseRuntimes.open(root)
    let b: BaseRuntimes | undefined
    try {
      const body = Buffer.from(
          '#!/bin/sh\nprintf "%s" "$$" > verification.pid\nsleep 30\nprintf "must not finish" > verification-finished.txt\n'
        ),
        header = Buffer.alloc(512)
      new Header({
        path: 'python/bin/python3',
        type: 'File',
        size: body.length,
        mode: 0o755
      }).encode(header)
      const bytes = gzipSync(
        Buffer.concat([
          header,
          body,
          Buffer.alloc((512 - (body.length % 512)) % 512),
          Buffer.alloc(1024)
        ])
      )
      const archiveFile = join(root, 'fixture.tar.gz')
      await writeFile(archiveFile, bytes)
      const spec = {
        ...official,
        platform: process.platform as 'darwin' | 'linux',
        arch: process.arch as 'arm64' | 'x64',
        entrypoint: 'python/bin/python3',
        archiveFile,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
      const first = a.start(spec, 'owned-verification')
      const directory = join(a.directory, first.id)
      let pid = 0
      for (let i = 0; i < 200; i++) {
        try {
          pid = Number(
            await readFile(join(directory, 'verification.pid'), 'utf8')
          )
          if (pid > 1) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(pid).toBeGreaterThan(1)
      expect(a.get(first.id).state).toBe('verifying')
      b = await BaseRuntimes.open(root)
      expect(b.get(first.id).state).toBe('verifying')
      expect(() => b!.start(spec, 'foreign-install')).toThrow(/Another Host/)
      await expect(b.cancel(first.id)).rejects.toMatchObject({ status: 409 })
      await expect(a.removePartial(first.id)).rejects.toMatchObject({
        status: 409
      })
      expect((await a.cancel(first.id)).state).toBe('canceled')
      expect(() => process.kill(pid, 0)).toThrow()
      await expect(
        stat(join(directory, 'verification-finished.txt'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await a.removePartial(first.id)).state).toBe('removed')
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(b.get(first.id).state).toBe('removed')
    } finally {
      await a.dispose()
      await b?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  10000
)
it.skipIf(process.platform === 'win32')(
  'marks a dead owner receipt interrupted without resuming its installation',
  async () => {
    const { createRequire } = await import('node:module')
    const { spawnSync } = await import('node:child_process')
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
    const root = await mkdtemp(join(tmpdir(), 'oss-base-recovery-'))
    let manager = await BaseRuntimes.open(root)
    try {
      const record = manager.start(
        {
          ...official,
          platform: process.platform as 'darwin' | 'linux',
          arch: process.arch as 'arm64' | 'x64',
          archiveFile: join(root, 'does-not-exist')
        },
        'orphan'
      )
      await manager.dispose()
      const dead = spawnSync(process.execPath, ['-e', ''])
      expect(dead.status).toBe(0)
      const db = new DatabaseSync(join(root, 'python-runtimes.sqlite'))
      try {
        db.prepare(
          "UPDATE installs SET record_json=json_set(record_json,'$.state','extracting') WHERE id=?"
        ).run(record.id)
        db.prepare('UPDATE lease SET pid=?,token=? WHERE id=1').run(
          dead.pid,
          'old-owner'
        )
      } finally {
        db.close()
      }
      manager = await BaseRuntimes.open(root)
      expect(manager.get(record.id)).toMatchObject({
        state: 'interrupted',
        downloaded: 0
      })
      expect(manager.list().entries[0].state).toBe('interrupted')
      expect(manager.start(record.spec, 'orphan').state).toBe('interrupted')
      expect((await manager.removePartial(record.id)).state).toBe('removed')
    } finally {
      await manager.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)
it('opens a cold scientific workspace and runtime settings with an absent configured Python', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oss-no-python-'))
  const runtime = await OssRuntime.open({
    stateDir: join(root, 'state'),
    python: join(root, 'not-installed-python')
  })
  try {
    const project = await runtime.project(join(root, 'research'))
    expect(project.kernelState().state).toBe('cold')
    expect(runtime.pythonOverride).toBe(true)
    expect(runtime.baseRuntimes.list().entries).toEqual([])
    expect(
      (await runtime.managedEnvironments(project.workspace)).list().entries
    ).toEqual([])
    expect(project.snapshot().executions).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
