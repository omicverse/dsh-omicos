import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Omicos from '../src/host/index.js'

it('cold-loads in real rc.3 Cordis/ToolRuntime; exposes scientific tools and fails closed without approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omicos-harness-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = await ctx.plugin(Omicos, { workspace: directory, stateDir: join(directory, 'state'), backend: 'oss', upstreamBaseUrl: 'https://auth.omicos.cn', python: 'python3' })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('omicos_run_python')
    expect(names).toContain('omicos_notebook_state')
    expect(names).toContain('omicos_notebook_update')
    expect(names).toContain('omicos_notebook_run')
    expect(names).toContain('omicos_pipeline_state')
    expect(names).toContain('omicos_pipeline_start')
    expect(names).toContain('omicos_figure_state'); expect(names).toContain('omicos_figure_save')
    const figureDenied = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('figure-denied'), name: 'omicos_figure_save', arguments: { figure_json: '{}' } })
    expect(JSON.stringify(figureDenied)).toMatch(/denied|approval/i)

    expect(names).not.toContain('omicos_analyze')
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('context'), name: 'omicos_science_context', arguments: {} })
    expect(JSON.stringify(result)).toContain('scientific')
    const pipelineDenied = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('pipeline-denied'), name: 'omicos_pipeline_start', arguments: { definition_id: 'not-pinned', operation_id: 'no-approval' } })
    expect(JSON.stringify(pipelineDenied)).toMatch(/denied|approval/i)
    const deniedNotebook = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('notebook-denied'), name: 'omicos_notebook_update', arguments: { action: 'create', title: 'Unapproved' } })
    expect(JSON.stringify(deniedNotebook)).toMatch(/denied|approval/i)
    const notebooks = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('notebook-list'), name: 'omicos_notebook_state', arguments: {} })
    expect(JSON.stringify(notebooks)).not.toContain('Unapproved')
    const denied = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('danger'), name: 'omicos_run_python', arguments: { code: 'open("should-not-exist", "w").write("bad")', operation_id: 'denied' } })
    expect(JSON.stringify(denied)).toMatch(/denied|approval/i)
    const context = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('after'), name: 'omicos_science_context', arguments: {} })
    expect(JSON.stringify(context)).not.toContain('should-not-exist')
    await plugin.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('omicos_run_python')
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('keeps the explicitly selected Core tool surface without registering a second OSS scientific loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omicos-core-compat-'))
  const ctx = new Context()
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
  const server = createServer((request, response) => { void handler!(request, response) })
  try {
    ctx.provide('sessionController', {} as never)
    ctx.provide('connection', { authorizeIndex: () => true, requestRejection: () => undefined } as never)
    ctx.provide('webServer', { register: (entry: any) => { if (entry.path === '/omicos/oss') handler = entry.handler; return () => {} } } as never)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    const plugin = await ctx.plugin(Omicos, { workspace: directory, stateDir: join(directory, 'state'), backend: 'core', autoStart: false, upstreamBaseUrl: 'https://auth.omicos.cn', python: 'python3' })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('omicos_analyze')
    expect(names).not.toContain('omicos_run_python'); expect(names).not.toContain('omicos_notebook_run')
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as any).port}`
    const session = await (await fetch(`${origin}/omicos/oss/api/session`)).json() as any
    expect(session.backend).toBe('core')
    const chat = await (await fetch(`${origin}/omicos/oss/api/project/${session.projects[0].id}/chat`)).json() as any
    expect(chat.available).toBe(false)
    expect(chat.reason).toContain('Core 兼容后端')
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await plugin.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('omicos_analyze')
  } finally { server.closeAllConnections(); server.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
