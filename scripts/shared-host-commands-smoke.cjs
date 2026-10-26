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
    await rail.getByRole('button', { name: '记忆', exact: true }).click()
    const main = page.locator('[data-omicos-page="memory"]')
    const title = main.getByLabel('记忆标题', { exact: true })
    await title.fill('SHARED_HOST_MAIN_UNSAVED_FIXTURE')
    let prompted
    page.once('dialog', async (dialog) => {
      prompted = dialog.message()
      await dialog.dismiss()
    })
    await page.keyboard.press('Meta+Alt+KeyN')
    assert(prompted?.includes('记忆提案'))
    assert.equal(await title.inputValue(), 'SHARED_HOST_MAIN_UNSAVED_FIXTURE')
    page.once('dialog', (dialog) => dialog.accept())
    await page.keyboard.press('Meta+Alt+KeyN')
    await main.waitFor({ state: 'detached' })
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const right = page.locator('[data-rightbar-col]')
    await right
      .locator('[data-sidebar-right-guide-entry="omicos-memory"]')
      .click()
    const tab = right.locator('[data-omicos-page="memory"]')
    const tabTitle = tab.getByLabel('记忆标题', { exact: true })
    await tabTitle.fill('SHARED_HOST_TAB_UNSAVED_FIXTURE')
    let tabPrompt
    page.once('dialog', async (dialog) => {
      tabPrompt = dialog.message()
      await dialog.dismiss()
    })
    await page.keyboard.press('Meta+Alt+KeyW')
    assert(tabPrompt?.includes('记忆提案'))
    assert.equal(await tabTitle.inputValue(), 'SHARED_HOST_TAB_UNSAVED_FIXTURE')
    page.once('dialog', (dialog) => dialog.accept())
    await page.keyboard.press('Meta+Alt+KeyW')
    await tab.waitFor({ state: 'detached' })
    assert.equal(writes.length, 0)
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/omicos-shared-host-browser.png'
      ),
      animations: 'disabled'
    })
    console.log(
      JSON.stringify({
        app: 'real Harness root served by the already-running native Host',
        nativeProcessAndScientificRuntime: 'unchanged, shared',
        scientist: 'native preset selector',
        mainNavigation: 'keyboard cancel retains text; accept leaves page',
        scopedTabClose: 'keyboard cancel retains text; accept closes tab',
        memoryProposalWrites: writes.length,
        pageErrors: errors
      })
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
