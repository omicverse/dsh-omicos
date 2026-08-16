/**
 * Where the omicos-core binary comes from.
 *
 * `@omicverse/omicos` is a real dependency of this plugin, so installing the
 * plugin already brought the core down (a 6 KB launcher shim plus the ~22 MB
 * platform binary that npm picks by optionalDependency). Spawning it through
 * `npx -y @omicverse/omicos` — the launcher's default — would then ignore what
 * is already on disk and go back to the network on first use, which is where
 * the multi-minute first-tool-call stall came from.
 *
 * So: resolve the installed shim and exec it with node. Falling back to the
 * launcher's own default matters for the case where this package was linked
 * or vendored without its dependencies.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** argv for `omicos serve`, mirroring the launcher's own `defaultCommand`. */
export interface CoreCommand {
  command: string
  args: string[]
}

/**
 * The installed `@omicverse/omicos` launcher shim, or `undefined` when the
 * dependency is not resolvable from here.
 *
 * `bin/omicos.js` (not the platform package's raw binary) on purpose: the shim
 * is what maps platform+arch to the right `@omicverse/omicos-<os>-<cpu>`, and
 * duplicating that table here would rot the moment a target is added.
 */
export function resolveInstalledCore(requireImpl = createRequire(import.meta.url)): string | undefined {
  try {
    // The package exports no main entry, so resolve its manifest and walk to bin.
    const manifest = requireImpl.resolve('@omicverse/omicos/package.json')
    return join(manifest.slice(0, -'package.json'.length), 'bin', 'omicos.js')
  } catch {
    return undefined
  }
}

/**
 * A `SpawnCommandOverride` for the installed core, or `undefined` to let the
 * launcher fall back to `npx`.
 *
 * 🔴 The override bypasses the launcher's own argv construction entirely
 * (`--data-dir` / `--upstream-base-url` are NOT appended for an override), so
 * every flag the default builds has to be restated here — dropping one would
 * silently point the core at the wrong data dir or the wrong cloud.
 */
export function installedCoreCommand(
  workspaceDir: string,
  upstreamBaseUrl: string | undefined,
  resolve = resolveInstalledCore,
): CoreCommand | undefined {
  const shim = resolve()
  if (shim === undefined) return undefined
  return {
    // process.execPath, not the shim's shebang: no dependency on the file
    // being executable or on `node` resolving the same way on PATH.
    command: process.execPath,
    args: [
      shim,
      'serve',
      '--host',
      '127.0.0.1',
      '--report-port',
      '--no-browser',
      '--data-dir',
      join(workspaceDir, '.omicos'),
      '--upstream-base-url',
      upstreamBaseUrl ?? 'https://auth.omicos.cn',
    ],
  }
}
