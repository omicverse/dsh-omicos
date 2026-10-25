/** OmicOS product profile over the published Harness; no embedded or simulated model loop. */
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const lockfile = require('proper-lockfile')
const ROOT = path.resolve(__dirname, '..')
const VERSION = '0.2.1-rc.3'

async function launchApplication({
  home,
  workspace,
  python = 'python3',
  rscript = 'Rscript',
  port = 0,
  locale = 'zh-x-omicos',
  noOpen = true
}) {
  const base = path.resolve(home)
  const project = await fs.realpath(path.resolve(workspace))
  if (!(await fs.stat(project)).isDirectory())
    throw Error('Workspace must be a directory')
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('Port must be 0–65535')
  if (!['zh-x-omicos', 'en-x-omicos'].includes(locale))
    throw Error('Unsupported application locale')
  if (!python.trim() || !rscript.trim())
    throw Error('Python and R executable names cannot be empty')
  await fs.mkdir(base, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(base, {
    realpath: true,
    stale: 30000,
    update: 10000,
    retries: 0
  })
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['--yes', `--package=@deepseek-ai/dsh@${VERSION}`, 'dsh']
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
  env.DSH_HOME = path.join(base, 'harness')
  env.DSH_AGENTS_HOME = path.join(base, 'agents')
  let child
  let stopping = false
  const forward = (signal) => {
    stopping = true
    child?.kill(signal)
  }
  const sigint = () => forward('SIGINT')
  const sigterm = () => forward('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  const run = (extra) =>
    new Promise((resolve, reject) => {
      child = spawn(command, [...args, ...extra], {
        cwd: project,
        env,
        stdio: 'inherit'
      })
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        code === 0 && !stopping
          ? resolve()
          : reject(Error(`Harness exited ${signal || code}`))
      )
    })
  try {
    await run(['plugin', '--profile', 'web', 'add', ROOT])
    // Bundle defaults precede the user profile patch. CLI overlays would make these settings read-only.
    const defaultsBundle = path.join(base, 'application-defaults')
    await fs.mkdir(defaultsBundle, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(defaultsBundle, 'package.json'),
      JSON.stringify(
        {
          name: '@omicverse/omicos-application-defaults',
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
      path.join(defaultsBundle, 'cordis.patch.yml'),
      [
        '- id: agent-preset-registry',
        '  config:',
        '    default: omicos',
        '- id: locale',
        '  config:',
        `    preference: ${locale}`,
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    await run(['plugin', '--profile', 'web', 'add', defaultsBundle])

    // Only this generated overlay is replaced; profile patches and model settings stay user-owned.
    const overlay = path.join(base, 'omicos-application.patch.yml')
    const patch = [
      '- id: omicos',
      '  config:',
      '    backend: oss',
      '    workspace: ""',
      `    stateDir: ${JSON.stringify(path.join(base, 'state'))}`,
      `    python: ${JSON.stringify(python)}`,
      `    rscript: ${JSON.stringify(rscript)}`,
      '    autoStart: false',
      ''
    ].join('\n')
    await fs.writeFile(overlay, patch, { mode: 0o600 })
    await run([
      '--profile',
      'web',
      '--patch',
      overlay,
      ...(noOpen ? ['--no-open'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ])
  } catch (error) {
    if (!stopping) throw error
  } finally {
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
    await release()
  }
}
module.exports = { launchApplication }

if (require.main === module) {
  const options = {
    home: path.join(os.homedir(), '.omicos-oss', 'application'),
    workspace: process.cwd(),
    python: 'python3',
    rscript: 'Rscript',
    port: 0,
    locale: 'zh-x-omicos',
    noOpen: false
  }
  try {
    const argv = process.argv.slice(2)
    for (let index = 0; index < argv.length; index++) {
      const key = argv[index]
      if (key === '--help') {
        console.log(
          'OmicOS OSS application\n  --workspace DIRECTORY  --home DIRECTORY  --python EXECUTABLE  --rscript EXECUTABLE\n  --port PORT  --locale zh|en  --no-open\nModels are configured in the native application. Cloud subscriptions use the separate OmicOS Store.'
        )
        process.exit(0)
      }
      if (key === '--no-open') {
        options.noOpen = true
        continue
      }
      if (
        ![
          '--workspace',
          '--home',
          '--python',
          '--rscript',
          '--port',
          '--locale'
        ].includes(key)
      )
        throw Error(`Unknown option: ${key}`)
      const value = argv[++index]
      if (!value || value.startsWith('--'))
        throw Error(`Missing value for ${key}`)
      if (key === '--port') {
        if (!/^\d+$/.test(value)) throw Error('Port must be an integer')
        options.port = Number(value)
      } else if (key === '--locale') {
        if (!['en', 'zh'].includes(value))
          throw Error('Locale must be en or zh')
        options.locale = `${value}-x-omicos`
      } else options[key.slice(2)] = value
    }
    launchApplication(options).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
