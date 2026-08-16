/**
 * Host bundle build.
 *
 * The point is the PUBLISHED dependency list: `@omicverse/omicos-protocol`,
 * `-client` and `-launcher` are this plugin's own layering, not something a
 * user should have to install three extra packages for, so they are inlined
 * here and kept as devDependencies. What stays external:
 *
 *   - `@deepseek-ai/*` — the harness supplies these. Bundling them would give
 *     us a SECOND copy of Schema/cordis, and config validation compares
 *     against the harness's own classes.
 *   - `@omicverse/omicos` — the core. It is never imported, only spawned as a
 *     child process (see coreCommand.ts), and it must stay a real dependency
 *     so installing the plugin installs the core.
 *   - node builtins.
 */
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/host/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  sourcemap: true,
  // Bare `@deepseek-ai/x` and any subpath; `@omicverse/omicos` but NOT
  // `@omicverse/omicos-client` (the trailing-boundary alternation is what
  // keeps the SDK from escaping the bundle).
  external: ['@deepseek-ai/*', '@omicverse/omicos', '@omicverse/omicos/*'],
  packages: undefined,
  logLevel: 'warning',
  metafile: true,
})

const bundled = Object.keys(result.metafile.inputs).filter((f) => f.includes('node_modules/@omicverse'))
console.log(`host bundle written: lib/host/index.js (inlined ${bundled.length} SDK modules)`)
