/**
 * Mode A tool surface (DSH-PLUGIN.md §3): omicos as a capability for the
 * DeepSeek-driven dsh agent. One tool RUNS an analysis (`omicos_analyze`,
 * routed through `OmicosRunner` so every call of one dsh session lands on
 * the SAME derived omicos conversation — context accumulates core-side);
 * the rest are direct core reads that cost neither a turn nor a token:
 * the capability catalog, the kernel's variables, and the artifacts.
 *
 * Figures: a turn's `generated_files` images are fetched from core
 * (`/api/files/preview`) and committed to `ctx.attachments` BEFORE the
 * tool result is returned, then rendered as ImageBlocks — the verified
 * first-party pattern (tool-fs read-image: persist in `execute`, carry
 * the `ImageAttachmentRef` inside the canonical value, emit the image
 * block in `render`). Attachments is an OPTIONAL service (tool-fs treats
 * it the same way): without it, figures degrade to path text.
 *
 * Long analyses: `background: true` starts an `omicos-analysis` job
 * (D6 — tool results are single-shot; `ctx.jobs` is the sanctioned
 * long-task channel). Live tqdm progress is exposed through the job's
 * `readOutput()` (labels are immutable — verified, no update API).
 */
import { HttpCoreTransport, getKernelVarDetail, getKernelVars, isDataVariable } from '@omicverse/omicos-client'
import { ActivityMirror } from './activity.js'
import { CapabilityIndex, DEFAULT_LIMIT, searchCatalog } from './capabilities.js'
import type { AccountService } from './account.js'
import type { ActivityStore } from './activity-store.js'
import type { OmicosTurnOutcome } from './bridge.js'
import type { OmicosPool, PoolEntry } from './pool.js'
import {
  defineTool,
  dshSessionIdOf,
  sessionCwdOf,
  type Context,
  type ContentBlock,
  type JobHooks,
  type ToolRunContext,
} from './dsh-compat.js'

export interface ToolDeps {
  pool: OmicosPool
  /** Explicit `config.workspace` override; empty = follow each dsh session's own workspace. */
  configWorkspace: string
  /** Live-activity feed the browser toolview polls (v0.2). Optional — tools run fine headless without it. */
  activity?: ActivityStore
  /** Used only to annotate capability hits the current plan cannot run. Optional: without it, no `locked` flags. */
  account?: AccountService
}

/** Fallback conversation bucket for a tool call with no owning agent (`ToolExecution.agent` is optional). */
const SHARED_SESSION = 'shared'

/** config override > the dsh session's own workspace (`session.header.cwd`) > host cwd. */
function entryFor(deps: ToolDeps, exec: ToolRunContext): PoolEntry {
  const dir = deps.configWorkspace || sessionCwdOf(exec) || process.cwd()
  return deps.pool.entry(dir)
}

function outcomeText(outcome: OmicosTurnOutcome): string {
  if (outcome.error) return `omicos turn failed: ${outcome.error}`
  return outcome.text || '(the omicos agent returned no text)'
}

/**
 * Model-visible failure with the bounded activity trace appended — the
 * dsh agent can diagnose WHAT failed inside omicos (which tool, last
 * stdout lines, the error) without the full trajectory entering its
 * context. Trace tail is capped again here as a hard token bound.
 */
function turnError(outcome: OmicosTurnOutcome): Error {
  const tail = outcome.trace.slice(-40)
  const trace = tail.length > 0 ? `\n\n[omicos activity trace, last ${tail.length} lines]\n${tail.join('\n')}` : ''
  return new Error(`${outcome.error ?? 'omicos turn failed'}${trace}`)
}

/**
 * 🔴 TEXT-ONLY on purpose (found live, 2026-08-15): tool-result `content`
 * is replayed into the MODEL's next request, and dsh's DeepSeek
 * chat-completions adapter rejects image content — an ImageBlock here
 * fails the whole turn with UNSUPPORTED_CONTENT right after the tool
 * succeeds. Figures reach the USER via `presentationMeta` + the keyed
 * toolview's `/omicos/figure` fetch instead; the model gets the paths.
 */
function renderOutcome(value: { answer: string; generated_files: unknown }): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: value.answer }]
  const files = Array.isArray(value.generated_files) ? value.generated_files.map(String) : []
  if (files.length > 0) {
    blocks.push({ type: 'text', text: `Files generated (workspace-relative): ${files.join(', ')}` })
  }
  return blocks
}

/** Register the Mode A tools. Returns the disposers from `ctx.tools.register` (caller owns effect wiring). */
export function registerOmicosTools(ctx: Context, deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []

  const runToOutcome = async (
    exec: ToolRunContext,
    message: string,
    onProgress?: (label: string) => void,
  ): Promise<{ outcome: OmicosTurnOutcome }> => {
    const sessionId = dshSessionIdOf(exec) ?? SHARED_SESSION
    const entry = entryFor(deps, exec)
    // Live feed for the browser toolview: full-state snapshots per callId,
    // ephemeral by design (see activity-store.ts for why NOT SessionEvents).
    const store = deps.activity
    const mirror = store === undefined ? undefined : new ActivityMirror((snap) => store.publish(exec.callId, snap))
    try {
      const outcome = await entry.runner.runTurn(sessionId, message, {
        onProgress,
        signal: exec.signal,
        onEvent: mirror === undefined ? undefined : (event) => mirror.consume(event),
      })
      mirror?.finish(outcome.error ? 'error' : 'ok', outcome.error)
      if (!outcome.error && outcome.generatedFiles.length === 0) {
        // Turn-level diff can miss files an earlier (orphan/idempotent) turn
        // already recorded — fall back to the conversation's latest set.
        try {
          outcome.generatedFiles = await entry.runner.lastGeneratedFiles(sessionId)
        } catch {
          // fallback only; empty stays empty
        }
      }
      return { outcome }
    } finally {
      mirror?.finish()
      store?.finish(exec.callId)
    }
  }

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'omicos_analyze',
        description:
          'Run a bioinformatics analysis with the OmicOS agent (single-cell/omics: scanpy, omicverse, R). ' +
          'It executes code in a persistent Python kernel bound to the workspace — state (e.g. `adata`) ' +
          'accumulates across calls in this conversation. Returns the final answer, generated files, and figures. ' +
          'Set background=true for long-running analyses (returns a job id to poll with the job tools).',
        parameters: {
          request: {
            type: 'string',
            required: true,
            description: 'What to analyze, in natural language. Include file paths when loading data.',
          },
          background: {
            type: 'boolean',
            description: 'Run as a background job instead of blocking (for multi-minute analyses).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string', required: true },
              generated_files: { type: 'array', required: true, items: { type: 'string' } },
              job_id: { type: 'string' },
            },
          },
          render: (_args, value) => renderOutcome(value),
          // Durable, replayable presentation facts (rides tool/result meta —
          // the client toolview reads figure paths from here and fetches
          // bytes via /omicos/figure, so settled cards survive host restarts).
          presentationMeta: (_args, value) => ({
            omicos: { generated_files: Array.isArray(value.generated_files) ? value.generated_files : [] },
          }),
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (args.background === true) {
            const jobs = ctx.get('jobs')
            if (jobs === undefined) {
              throw new Error('background analyses need @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs in the profile')
            }
            const sessionId = dshSessionIdOf(exec) ?? SHARED_SESSION
            const entry = entryFor(deps, exec)
            const jobId = jobs.start({
              kind: 'omicos-analysis',
              label: `omicos: ${args.request.slice(0, 80)}`,
              owner: exec.agent,
              run: (): JobHooks => {
                let lastProgress = ''
                let cancelled = false
                const turn = entry.runner.runTurn(sessionId, args.request, {
                  onProgress: (label) => (lastProgress = label),
                })
                return {
                  cancel: () => {
                    cancelled = true
                    void entry.runner.cancel(sessionId)
                  },
                  done: turn.then(
                    (outcome) => ({
                      status: cancelled ? ('killed' as const) : outcome.error ? ('failed' as const) : ('completed' as const),
                      detail: outcome.error,
                      output: outcomeText(outcome),
                    }),
                    (error: unknown) => ({ status: 'failed' as const, detail: String(error) }),
                  ),
                  readOutput: () => lastProgress || '(running — no progress reported yet)',
                }
              },
            })
            return { answer: `Started background omicos analysis (job ${jobId}). Poll it with the job tools.`, generated_files: [], job_id: jobId }
          }

          const { outcome } = await runToOutcome(exec, args.request)
          if (outcome.error) throw turnError(outcome)
          return {
            answer: outcomeText(outcome),
            generated_files: outcome.generatedFiles,
          }
        },
      }),
    ),
  )

  const capabilities = new CapabilityIndex()

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'omicos_capabilities',
        description:
          'Search what this OmicOS installation can actually do — its catalog of analysis skills and specialist ' +
          'agents (single-cell, spatial, bulk RNA-seq, ATAC, proteomics, network/enrichment, and more). ' +
          'Use it BEFORE deciding whether to hand a task to omicos_analyze, and to phrase that request in the ' +
          'right terms. Instant and free: a direct catalog read, not an analysis run. ' +
          'Query with a few keywords. Prefer ENGLISH technical terms ("pathway enrichment", "cell type annotation") — ' +
          'the catalog is written in English and Chinese queries match less reliably; if a Chinese query returns ' +
          'nothing relevant, retry it in English. ' +
          'Omit the query to get the catalog\'s categories and sizes instead of a ranked list. ' +
          'Note: results are a MENU, not commands — you do not invoke a skill by name, you describe the task to ' +
          'omicos_analyze and OmicOS routes it. Entries marked locked=true need a higher subscription plan.',
        parameters: {
          query: {
            type: 'string',
            description: 'Keywords, e.g. "spatial deconvolution", "trajectory", "differential expression". Omit for an overview.',
          },
          limit: {
            type: 'number',
            description: `Max results, 1-20 (default ${DEFAULT_LIMIT}).`,
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true },
              indexed: { type: 'json', required: true },
              plan: { type: 'string' },
              results: { type: 'array', required: true, items: { type: 'json' } },
              categories: { type: 'array', items: { type: 'json' } },
            },
          },
          render: (_args, value) => {
            const cats = Array.isArray(value.categories) ? value.categories : []
            if (cats.length > 0) {
              const lines = cats.map((c) => {
                const row = c as { category?: string; skills?: number; agents?: number }
                return `- ${String(row.category)}: ${row.skills ?? 0} skills, ${row.agents ?? 0} agents`
              })
              return [{ type: 'text', text: `OmicOS capability catalog by category:\n${lines.join('\n')}` }]
            }
            const hits = Array.isArray(value.results) ? value.results : []
            if (hits.length === 0) {
              return [{ type: 'text', text: `No OmicOS capability matches "${String(value.query)}". Try broader keywords, or omit the query for an overview.` }]
            }
            const lines = hits.map((h) => {
              const row = h as { kind?: string; title?: string; description?: string; tier?: string; locked?: boolean }
              const gate = row.locked === true ? ` [needs ${String(row.tier)}]` : ''
              return `- (${String(row.kind)}) ${String(row.title)}${gate}\n  ${String(row.description)}`
            })
            return [{ type: 'text', text: `OmicOS capabilities matching "${String(value.query)}":\n${lines.join('\n')}` }]
          },
        },
        async execute(args, exec) {
          const entry = entryFor(deps, exec)
          const handle = await entry.kernel.handle()
          const catalog = await capabilities.load(handle.baseUrl)
          // Plan is an ANNOTATION only — the gate itself is enforced core-side.
          // An unverified plan is treated as unknown rather than shown as
          // `community`, which would mislabel most of the catalog as locked.
          let plan: string | undefined
          try {
            const snap = await deps.account?.snapshot()
            if (snap?.plan?.verified === true) plan = snap.plan.code
          } catch {
            // annotation degrades; the search itself still answers
          }
          const found = searchCatalog(catalog, args.query ?? '', {
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(plan === undefined ? {} : { plan }),
          })
          return found as unknown as {
            query: string
            indexed: import('@deepseek-ai/dsh-tools').JsonValue
            plan?: string
            results: import('@deepseek-ai/dsh-tools').JsonValue[]
            categories?: import('@deepseek-ai/dsh-tools').JsonValue[]
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'omicos_list_variables',
        description:
          'List what currently lives in this conversation\'s OmicOS Python kernel (name, type, shape, size) — ' +
          'AnnData objects, DataFrames, arrays. Instant and free: it reads the kernel directly, it does NOT run ' +
          'an analysis. Call this before omicos_query_variable when you do not know the variable names, and after ' +
          'an analysis to see what it left behind.',
        parameters: {
          include_imports: {
            type: 'boolean',
            description: 'Also list imported modules/classes (default false — normally just noise).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kernel: { type: 'string', required: true },
              variables: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
          render: (_args, value) => {
            const vars = Array.isArray(value.variables) ? value.variables : []
            if (vars.length === 0) {
              return [{ type: 'text', text: 'The kernel has no user variables yet (run an analysis first).' }]
            }
            const lines = vars.map((v) => {
              const row = v as { name?: string; type?: string; shape?: string | null }
              return `- ${String(row.name)}: ${String(row.type)}${row.shape ? ` ${row.shape}` : ''}`
            })
            return [{ type: 'text', text: `Kernel variables:\n${lines.join('\n')}` }]
          },
        },
        async execute(args, exec) {
          const entry = entryFor(deps, exec)
          const handle = await entry.kernel.handle()
          const listing = await getKernelVars(new HttpCoreTransport(handle.baseUrl), entry.workspace)
          const vars = args.include_imports === true ? listing.vars : listing.vars.filter(isDataVariable)
          return {
            kernel: listing.kernel_id,
            variables: vars.map((v) => ({
              name: v.name,
              type: v.type,
              shape: v.shape,
              size_bytes: v.size_bytes,
              summary: v.summary,
            })) as unknown as import('@deepseek-ai/dsh-tools').JsonValue[],
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'omicos_query_variable',
        description:
          'Inspect one variable in this conversation\'s OmicOS kernel. For an AnnData this returns the ground ' +
          'truth core already holds: shape, obs/var columns, layers, obsm keys, and the PREPROCESSING STATE ' +
          '(is_int / is_normalized / is_log1p / is_scaled, value range) — which is what decides whether the next ' +
          'step is legal (never normalize twice). Instant and free: a direct kernel read, NOT an analysis run.',
        parameters: {
          name: {
            type: 'string',
            required: true,
            description: 'The Python variable name, e.g. "adata". Use omicos_list_variables if unsure.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean', required: true },
              name: { type: 'string', required: true },
              class: { type: 'string' },
              repr: { type: 'string' },
              summary: { type: 'json' },
            },
          },
          render: (args, value) => {
            if (value.available !== true) {
              return [
                {
                  type: 'text',
                  text: `\`${String(args.name)}\` is not defined in the kernel. Use omicos_list_variables to see what is.`,
                },
              ]
            }
            const parts = [`${String(value.name)}: ${String(value.class ?? 'unknown')}`]
            if (typeof value.repr === 'string' && value.repr !== '') parts.push(value.repr)
            if (value.summary !== undefined && value.summary !== null) {
              parts.push(JSON.stringify(value.summary))
            }
            return [{ type: 'text', text: parts.join('\n') }]
          },
        },
        async execute(args, exec) {
          // 🔴 A DIRECT READ, not a turn. This used to send "summarize the
          // variable X" to the omicos agent — minutes and a nested LLM call
          // to paraphrase what core answers exactly and for free.
          const entry = entryFor(deps, exec)
          const handle = await entry.kernel.handle()
          const detail = await getKernelVarDetail(new HttpCoreTransport(handle.baseUrl), args.name)
          return {
            available: detail.available,
            name: detail.name ?? args.name,
            ...(detail.class === undefined ? {} : { class: detail.class }),
            ...(detail.repr === undefined ? {} : { repr: detail.repr }),
            ...(detail.summary === undefined
              ? {}
              : { summary: detail.summary as unknown as import('@deepseek-ai/dsh-tools').JsonValue }),
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'omicos_list_generated_files',
        description: 'List every file the OmicOS analyses of this conversation have generated so far (plots, tables, h5ad exports).',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { files: { type: 'array', required: true, items: { type: 'string' } } },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                Array.isArray(value.files) && value.files.length > 0
                  ? `Generated files:\n${value.files.map((f) => `- ${String(f)}`).join('\n')}`
                  : 'No files generated yet.',
            },
          ],
        },
        async execute(_args, exec) {
          const sessionId = dshSessionIdOf(exec) ?? SHARED_SESSION
          return { files: await entryFor(deps, exec).runner.listGeneratedFiles(sessionId) }
        },
      }),
    ),
  )

  return disposers
}
