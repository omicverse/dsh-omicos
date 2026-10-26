/** Native development preview through the pinned public Harness desktop launcher. */
const { spawn } = require('node:child_process')
const { prepareDesktopSource } = require('./apply-desktop-branding.cjs')
const fs = require('node:fs/promises')
const path = require('node:path')
const lockfile = require('proper-lockfile')
const ROOT = path.resolve(__dirname, '..')
async function launchDesktopPreview(options) {
  const source = await fs.realpath(options.source)
  prepareDesktopSource(source)
  for (const file of [
    'apps/desktop/lib/main.js',
    'apps/desktop-host/lib/index.js'
  ])
    await fs.access(path.join(source, file))
  const base = path.resolve(options.home)
  await fs.mkdir(base, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(base, {
    realpath: true,
    stale: 30000,
    update: 10000,
    retries: 0
  })
  const env = {}
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'TMPDIR',
    'LANG',
    'SHELL',
    'SystemRoot',
    'COMSPEC'
  ])
    if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, {
    DSH_HOME: path.join(base, 'harness'),
    DSH_AGENTS_HOME: path.join(base, 'agents'),
    DSH_DESKTOP_USER_DATA_DIR: path.join(base, 'electron-user-data'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0'
  })
  let child
  let stopping = false
  const stop = (signal) => {
    stopping = true
    child?.kill(signal)
  }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  const run = (args, cwd) =>
    new Promise((resolve, reject) => {
      child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
        cwd,
        env,
        stdio: 'inherit'
      })
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        code === 0 && !stopping
          ? resolve()
          : reject(Error(`Desktop preview exited ${signal || code}`))
      )
    })
  try {
    const defaults = path.join(base, 'application-defaults')
    await fs.mkdir(defaults, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(defaults, 'package.json'),
      JSON.stringify(
        {
          name: '@omicverse/omicos-desktop-preview-defaults',
          version: '0.0.0',
          private: true,
          dsh: { bundle: { patch: './cordis.patch.yml' } }
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
    await fs.writeFile(
      path.join(defaults, 'cordis.patch.yml'),
      [
        '- id: agent-preset-registry',
        '  config:',
        '    default: omicos',
        '- id: locale',
        '  config:',
        '    preference: zh-x-omicos',
        '- id: omicos',
        '  config:',
        '    backend: oss',
        '    workspace: ""',
        `    stateDir: ${JSON.stringify(path.join(base, 'state'))}`,
        `    python: ${JSON.stringify(options.python || 'python3')}`,
        `    rscript: ${JSON.stringify(options.rscript || 'Rscript')}`,
        '    autoStart: false',
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    console.log(`OmicOS native preview: isolated home ${base}`)
    console.log(
      `Native plugin manager packages (install in this order): ${ROOT}, ${defaults}`
    )
    console.log(
      'Starting the official desktop launcher; first use prepares its locked runtime dependencies.'
    )
    await run(['--yes', 'pnpm@11.28.5', 'run', 'start:desktop'], source)
  } catch (error) {
    if (!stopping) throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    await release()
  }
}
module.exports = { launchDesktopPreview }
if (require.main === module) {
  const options = {
    home: path.join(ROOT, 'test-results', 'desktop-preview')
  }
  try {
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index++) {
      const key = args[index]
      if (key === '--help') {
        console.log(
          'OmicOS native development preview\n  --source PINNED_HARNESS_DIRECTORY --home DIRECTORY\n  --python EXECUTABLE --rscript EXECUTABLE\nBuild Harness with build:artifacts and build:check, and install its locked Electron binary first.'
        )
        process.exit(0)
      }
      if (!['--source', '--home', '--python', '--rscript'].includes(key))
        throw Error(`Unknown option: ${key}`)
      const value = args[++index]
      if (!value || value.startsWith('--'))
        throw Error(`Missing value for ${key}`)
      options[key.slice(2)] = value
    }
    if (!options.source)
      throw Error(
        '--source is required; use the documented pinned public Harness checkout'
      )
    launchDesktopPreview(options).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
