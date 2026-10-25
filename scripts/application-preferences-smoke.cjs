/** Real, disposable Harness profile: native preference writes must survive application restart. */
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')
const redact = (text) => text.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
async function until(check) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error('Preference did not reach the native profile patch')
}
;(async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'omicos-application-settings-')
  )
  const home = path.join(directory, 'home'),
    workspace = path.join(directory, 'research')
  await fs.mkdir(workspace)
  const patch = path.join(
    home,
    'harness',
    'profiles',
    'web',
    'cordis.patch.yml'
  )
  let child, browser
  let diagnostics = ''
  const errors = []
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(force)
    assert.equal(
      child.exitCode,
      0,
      'Requested application shutdown should be clean'
    )
  }
  const launch = async () => {
    diagnostics = ''
    child = spawn(
      process.execPath,
      [
        path.join(root, 'scripts/launch-application.cjs'),
        '--home',
        home,
        '--workspace',
        workspace,
        '--python',
        '/must-not-execute-for-settings',
        '--no-open'
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-10000)
    })
    return new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(
        () =>
          reject(
            Error('Application startup timed out: ' + redact(diagnostics))
          ),
        120000
      )
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(Error('Application exited ' + code + ': ' + redact(diagnostics)))
      })
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-18000)
        const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
        if (link) {
          clearTimeout(timeout)
          resolve(link[0])
        }
      })
    })
  }
  const enter = async (page, url) => {
    await page.goto(url)
    await page
      .getByRole('navigation', { name: 'OmicOS 功能导航', exact: true })
      .waitFor()
    const notice = page.getByRole('button', { name: /^(Continue|继续)$/ })
    try {
      await notice.waitFor({ timeout: 4000 })
      await notice.click()
    } catch (error) {
      if (!String(error).includes('Timeout')) throw error
    }
    const close = page.getByRole('button', { name: /^(Close|关闭)$/ })
    try {
      await close.waitFor({ timeout: 4000 })
      await close.click()
    } catch (error) {
      if (!String(error).includes('Timeout')) throw error
    }
  }
  const settings = async (page) => {
    await page
      .getByRole('button', { name: /^(Account menu|账号菜单)$/ })
      .click()
    await page.getByRole('menuitem', { name: /^(Settings|设置)/ }).click()
  }
  try {
    console.log(
      'Verifying native application language/default-Agent settings with a real Harness profile…'
    )
    let url = await launch()
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.OMICOS_BROWSER_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 }
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await enter(page, url)
    await settings(page)
    const language = page.locator('[data-omicos-language]')
    await language.waitFor()
    assert.deepEqual(
      await language
        .locator('option')
        .evaluateAll((nodes) => nodes.map((node) => node.value)),
      ['zh-x-omicos', 'en-x-omicos']
    )
    await language.selectOption('en-x-omicos')
    await until(async () =>
      /en-x-omicos/.test(await fs.readFile(patch, 'utf8'))
    )
    await page
      .getByRole('button', { name: 'Agent presets', exact: true })
      .click()
    const standard = page.locator(
      '[data-agent-preset-id="standard"] button[aria-pressed]'
    )
    await standard.click()
    await until(async () =>
      /selectedDefault:\s*["']?standard/.test(await fs.readFile(patch, 'utf8'))
    )
    await stop()
    await assert.rejects(fs.stat(home + '.lock'), { code: 'ENOENT' })
    url = await launch()
    await enter(page, url)
    await page.waitForFunction(() =>
      document.documentElement.lang.startsWith('en')
    )
    await settings(page)
    assert.equal(
      await page.locator('[data-omicos-language]').inputValue(),
      'en-x-omicos'
    )
    await page
      .getByRole('button', { name: 'Agent presets', exact: true })
      .click()
    assert.equal(
      await page
        .locator('[data-agent-preset-id="standard"] button[aria-pressed]')
        .getAttribute('aria-pressed'),
      'true'
    )
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()
    const state = await page.evaluate(async () => {
      const session = await (await fetch('/omicos/oss/api/session')).json()
      return (
        await fetch(
          `/omicos/oss/api/project/${session.projects[0].id}/snapshot`
        )
      ).json()
    })
    assert.equal(state.executions.length, 0)
    assert.equal(state.kernel.state, 'cold')
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        language:
          'native row, product variants, persisted English after restart',
        defaultAgent:
          'native Standard selection survives OmicOS deployment default and restart',
        models: 'no fixture or API key',
        executions: 0,
        browserErrors: errors
      })
    )
  } finally {
    await browser?.close()
    await stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(redact(error.stack || String(error)))
  process.exitCode = 1
})
