/** Isolated, genuine user preview; no API keys or cloud account are synthesized. */
const fs = require('node:fs/promises')
const path = require('node:path')
const { launchApplication } = require('./launch-application.cjs')
const base = path.resolve(__dirname, '..', 'test-results', 'harness-preview')
;(async () => {
  const workspace = path.join(base, 'research')
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
  await launchApplication({
    home: base,
    workspace,
    python: process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3',
    port: Number(process.env.OMICOS_PREVIEW_PORT || 0)
  })
})().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
