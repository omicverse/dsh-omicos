import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Omicos from '../src/host/index.js'

it('registers and mounts OmicOS Scientist with the real rc.3 preset Loader, without leaking its persona globally', async () => {
  await promisify(execFile)(process.execPath, ['esbuild.host.mjs'], { cwd: new URL('../', import.meta.url) })
  const directory = await mkdtemp(join(tmpdir(), 'omicos-preset-'))
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentPresets, { default: 'omicos' })
    const plugin = await ctx.plugin(Omicos, { workspace: directory, stateDir: join(directory, 'state'), backend: 'oss', upstreamBaseUrl: 'https://auth.omicos.cn', python: 'python3' })
    // Optional injections activate asynchronously; wait for the real registration.
    for (let i = 0; i < 50 && !(await ctx.agentPresets.list()).some(preset => preset.id === 'omicos'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    const roster = await ctx.agentPresets.list()
    expect(roster.find(preset => preset.id === 'omicos')).toBeTruthy()
    const scope = await ctx.agentPresets.acquireScope('omicos')
    try {
      const assembled = await ctx.systemPrompt.assemble({ scope: scope.key })
      expect(JSON.stringify(assembled)).toContain('You are OmicOS')
      expect(JSON.stringify(assembled)).toContain('omicos_scientific_skill')
      expect(JSON.stringify(await ctx.systemPrompt.assemble())).not.toContain('You are OmicOS')
    } finally { await scope[Symbol.asyncDispose]() }
    await plugin.dispose()
    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'omicos')).toBe(false)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 20000)
