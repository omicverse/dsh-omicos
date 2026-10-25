/**
 * Bundle public SDK adapters and standalone scientific services. Harness
 * packages remain external to preserve the single Cordis/service identity.
 * Core is optional at runtime and is never bundled or installed by default.
 */
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/host/index.js',
  bundle: true,
  banner: { js: "import { createRequire as __omicosRequireFactory } from 'node:module'; const require = __omicosRequireFactory(import.meta.url);" },
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

await build({ entryPoints: ['src/oss/cli.ts'], outfile: 'lib/oss/cli.js', bundle: true,
  banner: { js: "import { createRequire as __omicosRequireFactory } from 'node:module'; const require = __omicosRequireFactory(import.meta.url);" },
  platform: 'node', format: 'esm', target: 'node22', sourcemap: true, logLevel: 'warning' })

await build({ entryPoints: ['src/host/scientist.ts'], outfile: 'lib/host/scientist.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@deepseek-ai/*'], logLevel: 'warning' })
