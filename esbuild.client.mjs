/**
 * Client bundle build: emits the closure-factory artifact dsh's module
 * loader expects (verified contract, cordis-client-runner runtime.ts:98-101):
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => surface })
 *
 * Platform modules (react, cordis, the shared client packages — web shell
 * platform.ts) stay external and resolve through the injected `require`
 * from the loader's module table. Everything else is inlined.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { writeBundleNotices } from './scripts/notices.mjs'
import { readFile, writeFile } from 'node:fs/promises'

const ID = '@omicverse/dsh-omicos'

/** packages/client/web/src/platform.ts PLATFORM_MODULES + module-table client packages we touch. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
]

await build({
  entryPoints: ['src/client/index.ts'],
  plugins: [{ name: 'inline-css', setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?inline$/, '')), namespace: 'inline-css' }))
    builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }))
  } }],
  bundle: true,
  outfile: 'lib/client.cjs.tmp',
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNALS,
  sourcemap: false,
  minify: false,
})

const cjs = await readFile('lib/client.cjs.tmp', 'utf8')
const wrapped = `// @omicverse/dsh-omicos client bundle (closure-factory contract)
window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    (function (require, module, exports) {
${cjs}
    })(require, module, exports);
    return module.exports;
  },
});
`
await writeFile('lib/client.js', wrapped)
console.error('client bundle written: lib/client.js')

// Standalone workbench owns its React runtime; the DSH closure remains platform-external.
const standalone = await build({ entryPoints: ['src/client/oss-standalone.tsx'], bundle: true,
  outfile: 'lib/workbench.js', platform: 'browser', format: 'iife', target: 'es2022',
  jsx: 'automatic', minify: true, sourcemap: true, metafile: true })
await writeBundleNotices('workbench', standalone.metafile)
