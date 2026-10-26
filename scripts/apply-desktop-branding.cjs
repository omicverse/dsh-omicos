/** Apply the reviewable OmicOS native product patch to its pinned public source. */
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const metadata = require('../desktop/harness-source.json')
const patch = path.resolve(__dirname, '../desktop', metadata.patch)
function check(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: 'pipe' })
    return true
  } catch (error) {
    if (typeof error.status !== 'number') throw error
    return false
  }
}
function prepareDesktopSource(source, { apply = false } = {}) {
  const cwd = path.resolve(source)
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8'
  }).trim()
  if (revision !== metadata.revision)
    throw Error(`Expected Harness ${metadata.revision}, found ${revision}`)
  if (
    createHash('sha256').update(readFileSync(patch)).digest('hex') !==
    metadata.sha256
  )
    throw Error('Owned desktop patch does not match its recorded digest')
  if (check('git', ['apply', '--reverse', '--check', patch], cwd))
    return 'already applied'
  if (!apply)
    throw Error(
      'Apply the OmicOS native product patch before building: pnpm prepare:desktop-source --source DIRECTORY'
    )
  if (!check('git', ['apply', '--check', patch], cwd))
    throw Error(
      'Desktop patch conflicts with this checkout; preserve its changes and resolve the conflict before rebuilding'
    )
  execFileSync('git', ['apply', patch], { cwd, stdio: 'pipe' })
  return 'applied'
}
module.exports = { prepareDesktopSource }
if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--source')
      throw Error(
        'Usage: node scripts/apply-desktop-branding.cjs --source PINNED_HARNESS_DIRECTORY'
      )
    console.log(
      `OmicOS native product patch: ${prepareDesktopSource(args[1], { apply: true })}`
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
