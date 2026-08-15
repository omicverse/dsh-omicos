/**
 * Mode A tool surface (DSH-PLUGIN.md §3): omicos as a capability for the
 * DeepSeek-driven dsh agent. Three tools, all routed through
 * `OmicosRunner` so every call of one dsh session lands on the SAME
 * derived omicos conversation (context accumulates core-side).
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
import { classifyGeneratedFile, fetchFilePreview } from '@omicverse/omicos-client'
import type { OmicosTurnOutcome } from './bridge.js'
import type { OmicosPool, PoolEntry } from './pool.js'
import {
  SAVEABLE_IMAGE_TYPES,
  defineTool,
  dshSessionIdOf,
  sessionCwdOf,
  type Context,
  type ContentBlock,
  type ImageAttachmentRef,
  type ImageMediaType,
  type JobHooks,
  type ToolRunContext,
} from './dsh-compat.js'

export interface ToolDeps {
  pool: OmicosPool
  /** Explicit `config.workspace` override; empty = follow each dsh session's own workspace. */
  configWorkspace: string
  /** Figures larger than this go path-only instead of into the dsh attachment store (DSH-PLUGIN.md §7). */
  maxAttachmentBytes: number
}

/** Fallback conversation bucket for a tool call with no owning agent (`ToolExecution.agent` is optional). */
const SHARED_SESSION = 'shared'

/** config override > the dsh session's own workspace (`session.header.cwd`) > host cwd. */
function entryFor(deps: ToolDeps, exec: ToolRunContext): PoolEntry {
  const dir = deps.configWorkspace || sessionCwdOf(exec) || process.cwd()
  return deps.pool.entry(dir)
}

interface SavedFigure {
  path: string
  ref: ImageAttachmentRef
}

interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
}

/**
 * Fetch each image in `files` from core and commit it to the attachment
 * store. Per-file failures degrade that file to path-only (a broken
 * figure must not fail an otherwise-complete analysis turn).
 */
async function saveFigures(
  coreBaseUrl: string,
  files: string[],
  attachments: AttachmentsLike | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<SavedFigure[]> {
  if (!attachments) return []
  const saved: SavedFigure[] = []
  for (const path of files) {
    const { kind, mimeType } = classifyGeneratedFile(path)
    if (kind !== 'image' || !SAVEABLE_IMAGE_TYPES.has(mimeType)) continue
    try {
      const preview = await fetchFilePreview(coreBaseUrl, path, { signal })
      if (preview.bytes.byteLength > maxBytes) continue
      const ref = await attachments.saveImage({
        data: preview.bytes,
        mediaType: mimeType as ImageMediaType,
        name: path.split('/').pop(),
      })
      saved.push({ path, ref })
    } catch {
      // path-only degradation; the file list in the result still names it
    }
  }
  return saved
}

function outcomeText(outcome: OmicosTurnOutcome): string {
  if (outcome.error) return `omicos turn failed: ${outcome.error}`
  return outcome.text || '(the omicos agent returned no text)'
}

function renderOutcome(value: {
  answer: string
  generated_files: unknown
  figures: unknown
}): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: value.answer }]
  const files = Array.isArray(value.generated_files) ? value.generated_files.map(String) : []
  if (files.length > 0) {
    blocks.push({ type: 'text', text: `Files generated (workspace-relative): ${files.join(', ')}` })
  }
  for (const fig of Array.isArray(value.figures) ? value.figures : []) {
    const saved = fig as unknown as SavedFigure
    if (saved && typeof saved === 'object' && saved.ref) {
      blocks.push({ type: 'image', attachment: saved.ref })
    }
  }
  return blocks
}

/** Register the three Mode A tools. Returns the disposers from `ctx.tools.register` (caller owns effect wiring). */
export function registerOmicosTools(ctx: Context, deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []

  const runToOutcome = async (
    exec: ToolRunContext,
    message: string,
    onProgress?: (label: string) => void,
  ): Promise<{ outcome: OmicosTurnOutcome; figures: SavedFigure[] }> => {
    const sessionId = dshSessionIdOf(exec) ?? SHARED_SESSION
    const entry = entryFor(deps, exec)
    const outcome = await entry.runner.runTurn(sessionId, message, { onProgress, signal: exec.signal })
    const handle = await entry.kernel.handle()
    const figures = await saveFigures(
      handle.baseUrl,
      outcome.generatedFiles,
      ctx.get('attachments'),
      deps.maxAttachmentBytes,
      exec.signal,
    )
    return { outcome, figures }
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
              figures: { type: 'array', required: true, items: { type: 'json' } },
              job_id: { type: 'string' },
            },
          },
          render: (_args, value) => renderOutcome(value),
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
            return { answer: `Started background omicos analysis (job ${jobId}). Poll it with the job tools.`, generated_files: [], figures: [], job_id: jobId }
          }

          const { outcome, figures } = await runToOutcome(exec, args.request)
          if (outcome.error) throw new Error(outcome.error)
          return {
            answer: outcomeText(outcome),
            generated_files: outcome.generatedFiles,
            figures: figures as unknown as import('@deepseek-ai/dsh-tools').JsonValue[],
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
          'Inspect a variable in the OmicOS kernel of this conversation (e.g. an AnnData object): shape, ' +
          'columns/keys, and a short summary. Cheaper than omicos_analyze for "what state do I have?" questions.',
        parameters: {
          name: {
            type: 'string',
            required: true,
            description: 'The Python variable name to inspect, e.g. "adata".',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { summary: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.summary }],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const { outcome } = await runToOutcome(
            exec,
            `Summarize the current state of the kernel variable \`${args.name}\`: its type, shape/dimensions, ` +
              'and key structure (for AnnData: obs/var columns, layers, obsm keys). If it does not exist, say so. ' +
              'Answer concisely, no figures.',
          )
          if (outcome.error) throw new Error(outcome.error)
          return { summary: outcomeText(outcome) }
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
