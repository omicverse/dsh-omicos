/** Real OmicOS application over the existing native Host; no second scientific runtime or model fixture. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
;(async () => {
  const log = await fs.readFile(
    path.resolve(__dirname, '../test-results/desktop-preview-launch.log'),
    'utf8'
  )
  const url = log.match(/dsh web: (http:\/\/\S+)/)?.[1]
  if (!url) throw Error('Start the native development preview first')
  const browser = await chromium.launch({
    executablePath:
      process.env.OMICOS_BROWSER_EXECUTABLE ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  })
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 950 }
    })
    page.setDefaultTimeout(30000)
    const errors = [],
      writes = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/memory-propose')
      )
        writes.push(request.url())
    })
    await page.goto(url)
    await page.locator('.omicos-rail').waitFor()
    const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
    try {
      await notice.waitFor({ timeout: 8000 })
      await notice.click()
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
    }
    // Closing the optional model-connection prompt does not sign in or store credentials.
    const closeModel = page.getByRole('button', { name: /^(关闭|Close)$/ })
    try {
      await closeModel.waitFor({ timeout: 8000 })
      await closeModel.click()
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
    }
    const choose = page.getByText('选择工作区', { exact: true })
    if (await choose.isVisible()) {
      await choose.click()
      await page.getByText('默认工作区', { exact: true }).last().click()
    }
    await page
      .getByRole('button', { name: 'OmicOS Scientist', exact: true })
      .waitFor()
    if (await closeModel.isVisible()) await closeModel.click()
    const rail = page.getByRole('navigation', {
      name: 'OmicOS 功能导航',
      exact: true
    })
    const scopedSessionIds = []
    page.on('request', (request) => {
      if (
        request.url().endsWith('/open-session-project') &&
        request.method() === 'POST'
      )
        scopedSessionIds.push(request.postDataJSON().sessionId)
    })
    const workspacePath = path.resolve(
      __dirname,
      '../test-results/session-scope-fixture'
    )
    await fs.mkdir(workspacePath, { recursive: true })
    const result = await page.evaluate(async (workspacePath) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch('/api/workspace/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'workspace/create',
          payload: { args: { request: { path: workspacePath } } }
        })
      })
      return { status: response.status, body: await response.json() }
    }, workspacePath)
    assert.equal(result.body.result.ok, true)
    const picker = page.getByRole('button', { name: '选择工作区', exact: true })
    await picker.click()
    await page
      .getByRole('menuitem', { name: '默认工作区', exact: true })
      .click()
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    const original = page.getByLabel('科研工作区', { exact: true })
    await page.waitForFunction(
      () => document.querySelector('[aria-label="科研工作区"]')?.value
    )
    const originalPath = await original.locator('option:checked').textContent()
    assert.notEqual(originalPath, workspacePath)
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    await picker.click()
    await page
      .getByRole('menuitem', { name: 'session-scope-fixture', exact: true })
      .click()
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    const selector = page.getByLabel('科研工作区', { exact: true })
    await page.waitForFunction(
      (expected) => {
        const select = document.querySelector('[aria-label="科研工作区"]')
        return select?.selectedOptions[0]?.textContent === expected
      },
      workspacePath,
      { timeout: 30000 }
    )
    assert(
      new Set(scopedSessionIds).size >= 2,
      'Native workspace picks must produce different Session identities'
    )
    const differentSessionWorkspace = await selector
      .locator('option:checked')
      .textContent()
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const right = page.locator('[data-rightbar-col]')
    await right
      .locator('[data-sidebar-right-guide-entry="omicos-memory"]')
      .click()
    const scoped = right.locator('[data-omicos-page="memory"]')
    await scoped.getByText(workspacePath, { exact: true }).waitFor()
    assert.equal(
      await scoped.getByLabel('科研工作区', { exact: true }).count(),
      0
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        originalPath,
        differentSessionWorkspace,
        distinctSessions: new Set(scopedSessionIds).size,
        sidebarMatchesSession: true,
        errors
      })
    )
    await page.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/workspace-session-scope.png'
      ),
      animations: 'disabled'
    })
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    await picker.click()
    await page
      .getByRole('menuitem', { name: '默认工作区', exact: true })
      .click()
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
