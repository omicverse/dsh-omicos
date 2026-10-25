import { scientificSkill } from '../oss/skills.js'
import { inspectEnvironment } from '../oss/environment.js'
import { defineTool, sessionCwdOf, dshSessionIdOf, type Context, type ToolRunContext } from './dsh-compat.js'
import type { OssRuntime } from '../oss/runtime.js'
import type { ScienceService } from '../oss/science.js'

/** Scientifically conservative defaults, supplied to tools as task guidance. */
export const OMICOS_RESEARCH_GUIDANCE = 'Use the persistent project kernel. Inspect variables and AnnData state before transforms; do not repeat normalization/log transforms blindly. Record data paths, reference versions and uncertainty. Heavy recomputation requires user approval. Preserve raw data; export figures and reproducible notebooks. A tool success proves execution, not scientific validity.'

async function waitFor(service: ScienceService, id: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) { await service.cancel(id); throw new Error('Execution canceled') }
  return new Promise((resolve, reject) => {
    const check = () => {
      const job = service.get(id)
      if (!job || ['queued', 'running'].includes(job.state)) return
      cleanup(); resolve(job)
    }
    const aborted = () => { void service.cancel(id).catch(() => {}); cleanup(); reject(new Error('Cancellation requested; inspect omicos_execution_status for the execution terminal state')) }
    const cleanup = () => { service.off('change', check); signal.removeEventListener('abort', aborted) }
    service.on('change', check); signal.addEventListener('abort', aborted, { once: true }); check()
    if (signal.aborted) aborted()
  })
}
export function registerOssTools(ctx: Context, runtime: Promise<OssRuntime>, workspace: string): Array<() => void> {
  const project = async (exec: ToolRunContext) => (await runtime).project(workspace || sessionCwdOf(exec) || process.cwd())
  const render = (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }]
  const output = { schema: { type: 'object' as const, additionalProperties: false, properties: { result: { type: 'string' as const, required: true as const } } }, render }
  const response = (value: unknown) => ({ result: JSON.stringify(value) })
  return [
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow') return decision
      if (['omicos_run_python', 'omicos_project_memory_write'].includes(exec.name)) {
        return { kind: 'ask', reason: `OmicOS scientific operation requires approval: ${exec.name}\n${JSON.stringify(exec.arguments).slice(0, 4000)}` }
      }
      return decision
    }),
    ctx.tools.register(defineTool({ name: 'omicos_science_context', description: `Read project variables, project memory, recent executions and scientific guidance without launching Python. ${OMICOS_RESEARCH_GUIDANCE}`,
      parameters: {}, output, isConcurrencySafe: () => true,
      async execute(_args, exec) { const service = await project(exec); const snapshot = service.snapshot(); return response({ ...snapshot, executions: snapshot.executions.slice(-10).map(job => ({ id: job.id, state: job.state, createdAt: job.createdAt, artifacts: job.artifacts, output_tail: job.output.slice(-1000), error: job.error?.slice(-2000) })), guidance: OMICOS_RESEARCH_GUIDANCE }) } })),
    ctx.tools.register(defineTool({ name: 'omicos_run_python', description: 'Execute explicit Python code in the persistent OmicOS OSS project kernel. Supports scanpy/omicverse/AnnData when installed in the chosen environment; never installs packages silently. Use background=true for long tasks, then poll omicos_execution_status. This executes with the user OS permissions; approval is required.',
      parameters: { code: { type: 'string', required: true }, operation_id: { type: 'string', required: true, description: 'Stable operation ID; reuse only when retrying exactly the same request. Never rerun an interrupted job blindly.' }, background: { type: 'boolean' } }, output, isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const service = await project(exec)
        exec.signal.throwIfAborted()
        const job = await service.submit(args.code, args.operation_id, dshSessionIdOf(exec) || 'shared')
        if (args.background) return response(job)
        return response(await waitFor(service, job.id, exec.signal))
      } })),
    ctx.tools.register(defineTool({ name: 'omicos_execution_status', description: 'Read an OmicOS scientific execution including stdout, actual state and hashed artifacts. Empty id lists recent jobs.', parameters: { id: { type: 'string' } }, output, isConcurrencySafe: () => true,
      async execute(args, exec) { const service = await project(exec); return response(args.id ? service.get(args.id) || { error: 'Execution not found' } : service.snapshot().executions.slice(-20)) } })),
    ctx.tools.register(defineTool({ name: 'omicos_cancel_execution', description: 'Request cancellation of a project scientific execution. Query status to confirm the terminal state; partial namespace/file changes may remain.', parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
      async execute(args, exec) { const service = await project(exec); await service.cancel(args.id); return response(service.get(args.id)) } })),
    ctx.tools.register(defineTool({ name: 'omicos_project_memory_write', description: 'Save a user-confirmed project fact with an explicit source. Never store guessed facts as evidence. Empty text deletes the named memory.', parameters: { id: { type: 'string', required: true }, text: { type: 'string', required: true }, source: { type: 'string', required: true } }, output, isConcurrencySafe: () => false,
      async execute(args, exec) { const service = await project(exec); await service.remember(args.id, args.text, args.source); return response({ saved: true }) } })),
    ctx.tools.register(defineTool({ name: 'omicos_scientific_skill', description: 'List or read bundled public scientific checklists: AnnData auditing, single-cell QC, replicate-aware differential expression, reproducible figures. These are guidance, not evidence or automatic scientific validation.', parameters: { id: { type: 'string' } }, output, isConcurrencySafe: () => true,
      async execute(args) { return response(scientificSkill(args.id)) } })),
    ctx.tools.register(defineTool({ name: 'omicos_environment', description: 'Inspect the selected Python interpreter and scientific package versions without importing heavy packages or installing anything. Missing packages are reported as null.', parameters: {}, output, isConcurrencySafe: () => true,
      async execute(_args, exec) { return response(await inspectEnvironment((await project(exec)).python)) } })),
    ctx.tools.register(defineTool({ name: 'omicos_cloud_store', description: 'Read OmicOS cloud account and workbench/store URLs. Purchases require the user to open the store and confirm; no payment or subscription mutation is exposed as an agent tool.', parameters: {}, output, isConcurrencySafe: () => true,
      async execute() { return response({ account: (await runtime).cloud.snapshot(), workbench: '/omicos/oss', store: '/omicos/oss/store' }) } })),
  ]
}
