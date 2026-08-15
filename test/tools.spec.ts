/**
 * Drives the REAL `defineTool` definitions (from the pinned
 * @deepseek-ai/dsh-tools package) against a MockCore-backed runner — the
 * dsh-facing layer's divergence points: session identity derivation from
 * `exec.agent.id`, figure save-or-degrade, background job hooks, and the
 * error posture (`execute` throws on a failed turn).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreHandle } from '@omicverse/omicos-launcher'
import { OmicosPool } from '../src/host/pool.js'
import { registerOmicosTools } from '../src/host/tools.js'
import type { Context } from '../src/host/dsh-compat.js'
import { MockCore, fixtureTurn, respondJson, startSse, writeSseFrame } from '../../../packages/client/test/helpers/mockCore.js'

const SID = 'dsh-sess-1'

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

function poolFor(mock: MockCore): OmicosPool {
  const handle: CoreHandle = { baseUrl: mock.baseUrl, port: 0, pid: 1, spawned: false, stop: () => {} }
  return new OmicosPool({ ensureImpl: async () => handle })
}

interface RegisteredTool {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: never) => Array<{ type: string; [k: string]: unknown }> }
}

interface FakeCtx {
  ctx: Context
  tools: RegisteredTool[]
  disposed: string[]
  services: Record<string, unknown>
}

function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const tools: RegisteredTool[] = []
  const disposed: string[] = []
  const ctx = {
    tools: {
      register(definition: RegisteredTool) {
        tools.push(definition)
        return () => disposed.push(definition.name)
      },
    },
    get(name: string) {
      return services[name]
    },
  } as unknown as Context
  return { ctx, tools, disposed, services }
}

function serveHappyTurn(mock: MockCore): void {
  mock.on('POST', '/api/conversations/', (req, res) =>
    respondJson(res, 200, { session_id: (req.json as { session_id?: string }).session_id }),
  )
  mock.on('POST', '/api/agent/chat/stream', (_req, res) => {
    startSse(res)
    for (const frame of fixtureTurn(SID)) writeSseFrame(res, frame)
    res.end()
  })
}

function deps(mock: MockCore, maxAttachmentBytes = 4 * 1024 * 1024) {
  return { pool: poolFor(mock), configWorkspace: '/ws', maxAttachmentBytes }
}

const EXEC = { agent: { id: 'sess-1' }, signal: undefined }

describe('registerOmicosTools', () => {
  it('registers the three Mode A tools and returns their disposers', async () => {
    const mock = await startCore()
    const { ctx, tools, disposed } = fakeCtx()
    const disposers = registerOmicosTools(ctx, deps(mock))
    expect(tools.map((t) => t.name)).toEqual(['omicos_analyze', 'omicos_query_variable', 'omicos_list_generated_files'])
    for (const d of disposers) d()
    expect(disposed).toEqual(['omicos_analyze', 'omicos_query_variable', 'omicos_list_generated_files'])
  })

  it('omicos_analyze runs a turn on the conversation derived from exec.agent.id and renders the answer', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)
    const { ctx, tools } = fakeCtx()
    registerOmicosTools(ctx, deps(mock))
    const analyze = tools[0]!

    const value = await analyze.execute({ request: 'cluster my cells' }, EXEC)
    expect(value.answer).toBe('Hello, world')

    const chat = mock.requests.find((r) => r.path === '/api/agent/chat/stream')
    expect(chat?.headers['x-agent-session-id']).toBe(SID)

    const blocks = analyze.output.render({ request: 'cluster my cells' }, value as never)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Hello, world' })
  })

  it('saves figure bytes into the attachments service and renders an ImageBlock', async () => {
    const mock = await startCore()
    mock.on('POST', '/api/conversations/', (_req, res) => respondJson(res, 200, {}))
    mock.on('POST', '/api/agent/chat/stream', (_req, res) => {
      startSse(res)
      const frames = fixtureTurn(SID)
      // Splice a final assistant step carrying generated_files before `done`.
      const done = frames.pop()!
      for (const frame of frames) writeSseFrame(res, frame)
      writeSseFrame(res, {
        data: {
          type: 'step',
          session_id: SID,
          request_id: 'req_1',
          runtime_uid: 'runtime_test',
          event_seq: 98,
          content: { role: 'assistant', content: 'made a plot', generated_files: ['figures/umap.png', 'results/table.csv'] },
        },
        id: 98,
      })
      writeSseFrame(res, done)
      res.end()
    })
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    mock.on('GET', '/api/files/preview', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(PNG))
    })

    const savedInputs: Array<{ mediaType: string; name?: string; bytes: number }> = []
    const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
    const { ctx, tools } = fakeCtx({
      attachments: {
        saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
          savedInputs.push({ mediaType: input.mediaType, name: input.name, bytes: input.data.byteLength })
          return ref
        },
      },
    })
    registerOmicosTools(ctx, deps(mock))
    const analyze = tools[0]!

    const value = await analyze.execute({ request: 'plot umap' }, EXEC)
    // Only the .png went through the attachment pipeline; the .csv did not.
    expect(savedInputs).toEqual([{ mediaType: 'image/png', name: 'umap.png', bytes: 4 }])
    expect(value.generated_files).toEqual(['figures/umap.png', 'results/table.csv'])

    const blocks = analyze.output.render({}, value as never)
    expect(blocks.some((b) => b.type === 'image' && (b as { attachment?: unknown }).attachment === ref)).toBe(true)
  })

  it('a figure larger than maxAttachmentBytes degrades to path-only instead of failing', async () => {
    const mock = await startCore()
    mock.on('POST', '/api/conversations/', (_req, res) => respondJson(res, 200, {}))
    mock.on('POST', '/api/agent/chat/stream', (_req, res) => {
      startSse(res)
      const frames = fixtureTurn(SID)
      const done = frames.pop()!
      for (const frame of frames) writeSseFrame(res, frame)
      writeSseFrame(res, {
        data: {
          type: 'step', session_id: SID, request_id: 'req_1', runtime_uid: 'runtime_test', event_seq: 98,
          content: { role: 'assistant', content: 'big plot', generated_files: ['huge.png'] },
        },
        id: 98,
      })
      writeSseFrame(res, done)
      res.end()
    })
    mock.on('GET', '/api/files/preview', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.alloc(64))
    })

    let saveCalls = 0
    const { ctx, tools } = fakeCtx({ attachments: { saveImage: async () => { saveCalls += 1; return {} } } })
    registerOmicosTools(ctx, deps(mock, 16))
    const value = await tools[0]!.execute({ request: 'plot' }, EXEC)
    expect(saveCalls).toBe(0)
    expect(value.generated_files).toEqual(['huge.png'])
  })

  it('background=true without a jobs service is a clear error, with one it returns the job id and wires the hooks', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)

    const bare = fakeCtx()
    registerOmicosTools(bare.ctx, deps(mock))
    await expect(bare.tools[0]!.execute({ request: 'x', background: true }, EXEC)).rejects.toThrow(/dsh-jobs/)

    let captured: { kind: string; label: string; run: () => { done: Promise<unknown>; readOutput?: () => string } } | undefined
    const withJobs = fakeCtx({
      jobs: {
        start(spec: typeof captured) {
          captured = spec
          return 'job-1'
        },
      },
    })
    registerOmicosTools(withJobs.ctx, deps(mock))
    const value = await withJobs.tools[0]!.execute({ request: 'long analysis', background: true }, EXEC)
    expect(value.job_id).toBe('job-1')
    expect(captured?.kind).toBe('omicos-analysis')
    expect(captured?.label).toContain('long analysis')

    const hooks = captured!.run()
    expect(hooks.readOutput?.()).toMatch(/running/)
    const outcome = (await hooks.done) as { status: string; output?: string }
    expect(outcome.status).toBe('completed')
    expect(outcome.output).toBe('Hello, world')
  })

  it('workspace routing (regression: host cwd spawned a stray core): config override > session.header.cwd > host cwd', async () => {
    const mock = await startCore()
    serveHappyTurn(mock)
    const handle: CoreHandle = { baseUrl: mock.baseUrl, port: 0, pid: 1, spawned: false, stop: () => {} }
    const ensuredDirs: string[] = []
    const pool = new OmicosPool({
      ensureImpl: async (dir: string) => {
        ensuredDirs.push(dir)
        return handle
      },
    })
    const { ctx, tools } = fakeCtx()

    // No config override: the dsh SESSION's workspace wins over the host cwd.
    registerOmicosTools(ctx, { pool, configWorkspace: '', maxAttachmentBytes: 1 })
    const execWithWs = { agent: { id: 'sess-1', session: { header: { cwd: '/ws-from-dsh-ui' } } }, signal: undefined }
    await tools[0]!.execute({ request: 'x' }, execWithWs)
    expect(ensuredDirs).toEqual(['/ws-from-dsh-ui'])

    // Explicit config override beats the session workspace.
    const ctx2 = fakeCtx()
    registerOmicosTools(ctx2.ctx, { pool, configWorkspace: '/ws-forced', maxAttachmentBytes: 1 })
    await ctx2.tools[0]!.execute({ request: 'y' }, execWithWs)
    expect(ensuredDirs).toEqual(['/ws-from-dsh-ui', '/ws-forced'])
  })

  it('omicos_query_variable throws on a failed turn (error event) instead of returning prose', async () => {
    const mock = await startCore()
    mock.on('POST', '/api/conversations/', (_req, res) => respondJson(res, 200, {}))
    mock.on('POST', '/api/agent/chat/stream', (_req, res) => {
      startSse(res)
      writeSseFrame(res, { data: { type: 'error', session_id: SID, request_id: 'r', runtime_uid: 'rt', event_seq: 1, content: 'kernel exploded' }, id: 1 })
      writeSseFrame(res, { data: { type: 'done', reason: 'error', session_id: SID, request_id: 'r', runtime_uid: 'rt', event_seq: 2 }, id: 2 })
      res.end()
    })
    const { ctx, tools } = fakeCtx()
    registerOmicosTools(ctx, deps(mock))
    await expect(tools[1]!.execute({ name: 'adata' }, EXEC)).rejects.toThrow('kernel exploded')
  })
})
