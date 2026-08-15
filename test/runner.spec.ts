import { afterEach, describe, expect, it } from 'vitest'
import type { CoreHandle } from '@omicverse/omicos-launcher'
import { KernelManager } from '../src/host/kernel.js'
import { OmicosRunner } from '../src/host/runner.js'
import { MockCore, fixtureTurn, respondJson, startSse, writeSseFrame } from '../../../packages/client/test/helpers/mockCore.js'

const SID = 'dsh-sess-1' // deriveOmicosSessionId('sess-1')

let core: MockCore | undefined

afterEach(async () => {
  await core?.close()
  core = undefined
})

async function startCore(): Promise<MockCore> {
  core = new MockCore()
  await core.start()
  return core
}

function kernelFor(mock: MockCore): KernelManager {
  const handle: CoreHandle = {
    baseUrl: mock.baseUrl,
    port: 0,
    pid: 1,
    spawned: false,
    stop: () => {},
  }
  return new KernelManager({ workspace: '/ws', ensureImpl: async () => handle })
}

function serveHappyTurn(mock: MockCore): void {
  mock.on('POST', '/api/conversations/', (req, res) => {
    respondJson(res, 200, { session_id: (req.json as { session_id?: string }).session_id })
  })
  mock.on('POST', '/api/agent/chat/stream', (req, res) => {
    startSse(res)
    for (const frame of fixtureTurn(SID)) writeSseFrame(res, frame)
    res.end()
  })
}

describe('OmicosRunner.runTurn', () => {
  it('reserves the derived conversation id, pins the session header, and returns the accumulated outcome', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)
    const runner = new OmicosRunner(kernelFor(mock))

    const outcome = await runner.runTurn('sess-1', 'analyze my adata')

    expect(outcome.text).toBe('Hello, world')
    expect(outcome.finished).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.toolLog).toEqual(['run_python_code'])
    expect(outcome.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })

    const create = mock.requests.find((r) => r.path === '/api/conversations/')
    expect(create?.json).toMatchObject({ session_id: SID })
    const chat = mock.requests.find((r) => r.path === '/api/agent/chat/stream')
    expect(chat?.headers['x-agent-session-id']).toBe(SID)
    // v0.1 Mode A safety posture (§3): tools run in core unprompted.
    expect((chat?.json as { config?: { permission_mode?: string } }).config?.permission_mode).toBe('full')
  })

  it('a failed reservation (id already exists from a previous host run) is benign', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)
    mock.on('POST', '/api/conversations/', (_req, res) => respondJson(res, 409, { error: 'exists' }))
    const runner = new OmicosRunner(kernelFor(mock))

    const outcome = await runner.runTurn('sess-1', 'again')
    expect(outcome.text).toBe('Hello, world')
  })

  it('reserves only once across multiple turns of the same dsh session', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)
    const runner = new OmicosRunner(kernelFor(mock))

    await runner.runTurn('sess-1', 'first')
    await runner.runTurn('sess-1', 'second')

    const creates = mock.requests.filter((r) => r.path === '/api/conversations/')
    expect(creates).toHaveLength(1)
    const chats = mock.requests.filter((r) => r.path === '/api/agent/chat/stream')
    expect(chats).toHaveLength(2)
  })
})

describe('OmicosRunner.listGeneratedFiles', () => {
  it('aggregates generated_files across history, deduped, order-stable', async () => {
    const mock = await startCore()
    mock.on('GET', `/api/conversations/${SID}`, (_req, res) =>
      respondJson(res, 200, {
        session_id: SID,
        title: 't',
        created_at: 0,
        last_active: 0,
        history: [
          { role: 'assistant', content: 'turn 1', timestamp: 1, generated_files: ['a.png', 'b.csv'] },
          { role: 'user', content: 'next', timestamp: 2 },
          { role: 'assistant', content: 'turn 2', timestamp: 3, generated_files: ['b.csv', 'c.png'] },
        ],
      }),
    )
    const runner = new OmicosRunner(kernelFor(mock))
    expect(await runner.listGeneratedFiles('sess-1')).toEqual(['a.png', 'b.csv', 'c.png'])
  })

  it('a conversation that does not exist yet lists as empty, not as an error', async () => {
    const mock = await startCore()
    mock.on('GET', `/api/conversations/${SID}`, (_req, res) => respondJson(res, 404, { error: 'not found' }))
    const runner = new OmicosRunner(kernelFor(mock))
    expect(await runner.listGeneratedFiles('sess-1')).toEqual([])
  })
})
