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
    const bindings = []
    page.on('response', async (response) => {
      if (response.url().endsWith('/open-session-project') && response.ok())
        bindings.push(await response.json())
    })
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    const panel = page.locator('[data-omicos-page="data"]')
    const selector = panel.getByLabel('科研工作区', { exact: true })
    await page.waitForFunction(() => {
      const s = document.querySelector('[aria-label="科研工作区"]')
      return s && s.value
    })
    assert(
      bindings.length,
      'Main page must bind through the current native Session'
    )
    const binding = bindings.at(-1)
    assert.equal(await selector.inputValue(), binding.id)
    const selectedPath = await selector.locator('option:checked').textContent()
    assert(
      !selectedPath.includes('/harness/profiles/'),
      'Must not default to app configuration directory'
    )
    const alternatives = await selector
      .locator('option')
      .evaluateAll((options) =>
        options
          .map((o) => ({ value: o.value, text: o.textContent }))
          .filter((o) => o.value)
      )
    const alternative = alternatives.find((o) => o.value !== binding.id)
    assert(
      alternative,
      'Existing configuration project is available for explicit manual selection'
    )
    await selector.selectOption(alternative.value)
    assert.equal(await selector.inputValue(), alternative.value)
    await rail.getByRole('button', { name: '图库', exact: true }).click()
    const next = page
      .locator('[data-omicos-page="figures"]')
      .getByLabel('科研工作区', { exact: true })
    await page.waitForFunction(
      (id) => document.querySelector('[aria-label="科研工作区"]')?.value === id,
      binding.id
    )
    assert.equal(await next.inputValue(), binding.id)
    // Delay only a real Host response: an explicit choice must win the race.
    let releaseBinding
    const gate = new Promise((resolve) => {
      releaseBinding = resolve
    })
    let markReceived
    const received = new Promise((resolve) => {
      markReceived = resolve
    })
    await page.route(
      '**/omicos/oss/api/open-session-project',
      async (route) => {
        const response = await route.fetch()
        markReceived()
        await gate
        await route.fulfill({ response })
      }
    )
    await rail.getByRole('button', { name: 'Notebook', exact: true }).click()
    await received
    const delayed = page
      .locator('[data-omicos-page="notebook"]')
      .getByLabel('科研工作区', { exact: true })
    assert.equal(await delayed.inputValue(), '')
    await delayed.selectOption(alternative.value)
    const bindingResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/open-session-project') && response.ok()
    )
    releaseBinding()
    await bindingResponse
    // The ensuing real session refresh observes the fulfilled binding and React update.
    await page.waitForResponse(
      (response) =>
        response.url().endsWith('/omicos/oss/api/session') && response.ok()
    )
    assert.equal(await delayed.inputValue(), alternative.value)
    await page.unroute('**/omicos/oss/api/open-session-project')
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        sessionProject: binding.id,
        workspace: selectedPath,
        manualSelection: alternative.text,
        anotherPageFollowsSession: true,
        manualChoiceSurvivesLateBinding: true,
        errors
      })
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
