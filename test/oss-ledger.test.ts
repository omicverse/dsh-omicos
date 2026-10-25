import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ScienceLedger } from '../src/oss/ledger.js'
import { ScienceService } from '../src/oss/science.js'
import type { Execution } from '../src/oss/types.js'
const job = (id = 'one', operation = id): Execution => ({ id, operationId: operation, code: 'print(42)', sessionId: 'research', language: 'python', state: 'queued', createdAt: '2026-10-25T00:00:00Z', output: '', artifacts: [] })

describe('transactional scientific ledger', () => {
  let workspace: string; const ledgers: ScienceLedger[] = []
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'omicos-ledger-')) })
  afterEach(async () => { ledgers.splice(0).forEach(ledger => ledger.close()); await rm(workspace, { recursive: true, force: true }) })
  const open = async () => { const ledger = await ScienceLedger.open(workspace); ledgers.push(ledger); return ledger }
  it('upgrades an existing native schema-v1 ledger without losing confirmed facts or receipts', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const directory = join(workspace, '.omicos-oss'); await mkdir(directory)
    const db = new DatabaseSync(join(directory, 'project.sqlite'))
    db.exec(`CREATE TABLE executions(id TEXT PRIMARY KEY, language TEXT NOT NULL, operation_id TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(language,operation_id)); CREATE TABLE memories(id TEXT PRIMARY KEY, record_json TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,language TEXT NOT NULL,execution_id TEXT,at TEXT NOT NULL,data_json TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA application_id=1330466643; PRAGMA user_version=1;`)
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('legacy-json-imported', 'original-marker')
    db.prepare('INSERT INTO memories VALUES(?,?)').run('reference', JSON.stringify({ id: 'reference', text: 'GRCh38', source: 'researcher', updatedAt: '2026-01-01' }))
    db.prepare('INSERT INTO executions VALUES(?,?,?,?)').run('one', 'python', 'one', JSON.stringify(job()))
    db.close()
    const upgraded = await open()
    expect(upgraded.memories()[0].text).toBe('GRCh38')
    expect(upgraded.memory.history('reference', { owner: true }).revisions[0]).toMatchObject({ schema: 2, revision: 1, approvedBy: 'legacy-import', createdAt: '2026-01-01' })
    expect(upgraded.executions('python')[0]).toEqual(job())
    expect(upgraded.events().filter(event => event.type === 'memory/tree-migrated')).toHaveLength(1)
    upgraded.close(); const reopened = await open()
    expect(reopened.events().filter(event => event.type === 'memory/tree-migrated')).toHaveLength(1)
  })
  it('commits execution and sequenced receipts together; rejects mutable code and duplicate operation identities', async () => {
    const ledger = await open(); const record = job()
    ledger.saveExecutions('python', [record])
    const before = ledger.cursor
    expect(() => ledger.saveExecutions('python', [job('two'), { ...record, code: 'print(43)' }])).toThrow('immutable')
    expect(ledger.executions('python').map(job => job.id)).toEqual(['one'])
    expect(ledger.cursor).toBe(before)
    expect(() => ledger.saveExecutions('python', [job('duplicate', 'one')])).toThrow()
    const queued = ledger.events().find(event => event.type === 'execution/queued')!
    expect(queued.data.code_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(queued.data.provenance_scope).toContain('not inferred')
    expect((await stat(join(workspace, '.omicos-oss', 'project.sqlite'))).mode & 0o777).toBe(0o600)
  })
  it('imports legacy JSON once, preserves originals and never lets an old file overwrite the database', async () => {
    const directory = join(workspace, '.omicos-oss'); await mkdir(directory)
    const original = JSON.stringify([{ ...job(), state: 'running' }])
    await writeFile(join(directory, 'executions.json'), original)
    await writeFile(join(directory, 'memories.json'), JSON.stringify([{ id: 'reference', text: 'GRCh38', source: 'user', updatedAt: '2026-10-25' }]))
    const science = await ScienceService.open(workspace)
    expect(science.get('one')?.state).toBe('interrupted')
    expect(science.snapshot().memories[0].text).toBe('GRCh38')
    await science.dispose()
    expect(await readFile(join(directory, 'executions.json'), 'utf8')).toBe(original)
    await writeFile(join(directory, 'executions.json'), '[]')
    const ledger = await open()
    expect(ledger.executions('python')).toHaveLength(1)
    expect(ledger.executions('python')[0].state).toBe('interrupted')
  })
  it('replays receipts across reopen and shares sourced memory between language connections', async () => {
    const python = await open(); const r = await open()
    python.remember('fact', 'GRCh38', 'user confirmed')
    expect(r.memories()[0].text).toBe('GRCh38')
    const cursor = python.cursor
    r.remember('fact', '', 'user deletion')
    expect(python.events(cursor).map(event => event.type)).toEqual(['memory/deleted'])
    python.close(); r.close()
    const reopened = await open()
    expect(reopened.cursor).toBeGreaterThan(cursor)
    expect(reopened.memories()).toEqual([])
  })
})
