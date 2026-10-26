/** Full application acceptance against one already-running isolated native Host. */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const steps = [
  ['native-pages', 'desktop-application-smoke.cjs'],
  ['session-project', 'shared-host-project-smoke.cjs'],
  ['workspace-scope', 'shared-host-session-scope-smoke.cjs'],
  ['browser-commands', 'shared-host-commands-smoke.cjs'],
  ['data-notebook-memory', 'shared-host-data-notebook-smoke.cjs'],
  ['method-pipeline', 'shared-host-method-pipeline-smoke.cjs'],
  ['figure', 'shared-host-figure-smoke.cjs'],
  ['plan-dossier', 'shared-host-plan-dossier-smoke.cjs'],
  ['assembly', 'shared-host-assembly-smoke.cjs']
]
const results = []
for (const [name, script] of steps) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024
  })
  fs.writeFileSync(
    path.join(root, `test-results/acceptance-${name}.log`),
    (result.stdout || '') + (result.stderr || '')
  )
  const receipt = {
    name,
    passed: result.status === 0 && !result.error,
    seconds: Math.round((Date.now() - started) / 1000)
  }
  results.push(receipt)
  console.log(JSON.stringify(receipt))
  if (!receipt.passed) {
    process.exitCode = 1
    break
  }
}
fs.writeFileSync(
  path.join(root, 'test-results/application-acceptance.json'),
  JSON.stringify(
    {
      results,
      nativeForegroundInput:
        'separate foreground-only acceptance; not implied by this runner',
      realCloudPayment: 'not exercised'
    },
    null,
    2
  ) + '\n'
)
