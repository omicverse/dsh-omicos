import { Worker } from 'node:worker_threads'
import { EnvironmentError } from './environment-types.js'
import type { BaseRuntimeSpec } from './base-runtime-types.js'
export interface RuntimeFile {
  path: string
  type: 'file' | 'symlink' | 'directory'
  bytes?: number
  mode?: number
  sha256?: string
  target?: string
}
export interface RuntimeFileManifest {
  entries: RuntimeFile[]
  bytes: number
  entrypoint: string
}
const running = new Set<Worker>()
/** Caller owns private staging. Cancellation waits for worker exit before permitting cleanup. */
export async function unpackRuntimeArchive(
  spec: BaseRuntimeSpec,
  archive: string,
  destination: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; workerPath?: URL } = {}
): Promise<RuntimeFileManifest> {
  signal.throwIfAborted()
  if (running.size >= 2)
    throw new EnvironmentError(
      429,
      'Two runtime archive workers are already active'
    )
  return new Promise((resolve, reject) => {
    let failure: Error | undefined, result: RuntimeFileManifest | undefined
    const worker = new Worker(
      options.workerPath ||
        new URL('../../runtime/runtime_archive.cjs', import.meta.url),
      {
        workerData: {
          archive,
          destination,
          bytes: spec.bytes,
          sha256: spec.sha256,
          entrypoint: spec.entrypoint
        },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4
        }
      }
    )
    running.add(worker)
    const abort = () => {
      failure = new EnvironmentError(
        409,
        'Runtime extraction canceled; waiting for its worker to exit'
      )
      void worker.terminate()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timer = setTimeout(() => {
      failure = new EnvironmentError(
        408,
        'Runtime archive extraction exceeded its deadline'
      )
      void worker.terminate()
    }, options.timeoutMs || 300000)
    worker.on('message', (message) => {
      if (
        message.ok &&
        message.manifest &&
        Array.isArray(message.manifest.entries) &&
        message.manifest.entries.length <= 40000 &&
        JSON.stringify(message.manifest).length <= 10000000
      )
        result = message.manifest
      else
        failure = new EnvironmentError(
          400,
          String(message.error || 'Runtime archive manifest is invalid').slice(
            0,
            2000
          )
        )
    })
    worker.on('error', (error) => {
      failure ??= new EnvironmentError(
        500,
        `Runtime archive worker failed: ${error.message.slice(0, 500)}`
      )
    })
    worker.on('exit', (code) => {
      running.delete(worker)
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || !result)
        reject(
          new EnvironmentError(
            500,
            'Runtime archive worker exited without a complete manifest'
          )
        )
      else resolve(result)
    })
  })
}
