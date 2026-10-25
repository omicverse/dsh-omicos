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
    expect(names).not.toContain('omicos_analyze')
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('context'), name: 'omicos_science_context', arguments: {} })
    expect(JSON.stringify(result)).toContain('scientific')
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
