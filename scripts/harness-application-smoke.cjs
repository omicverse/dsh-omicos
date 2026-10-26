/** Navigation and appearance checks against the actual, keyless application preview. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { clickRailPage } = require('./rail-helper.cjs')
;(async () => {
  const root = path.resolve(__dirname, '..')
  const log = await fs.readFile(
    path.join(root, 'test-results/harness-preview-launch.log'),
    'utf8'
  )
  const launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
  if (!launch) throw Error('Start scripts/launch-harness-preview.cjs first')
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.OMICOS_BROWSER_EXECUTABLE ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  })
  const errors = []
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      reducedMotion: 'reduce'
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(launch)
    const rail = page.getByRole('navigation', {
      name: 'OmicOS 功能导航',
      exact: true
    })
    await rail.waitFor()
    const notice = page.getByRole('button', { name: /^(Continue|继续)$/ })
    try {
      await notice.waitFor({ timeout: 8000 })
      await notice.click()
    } catch (error) {
      if (!String(error).includes('Timeout')) throw error
    }
    const close = page.getByRole('button', { name: /^(Close|关闭)$/ })
    try {
      await close.waitFor({ timeout: 8000 })
      await close.click()
      await close.waitFor({ state: 'hidden' })
    } catch (error) {
      if (!String(error).includes('Timeout')) throw error
    }
    await page.waitForFunction(() => document.title.includes('OmicOS'))
    await page.getByText('OmicOS Scientist', { exact: true }).first().waitFor()
    await page.screenshot({
      animations: 'disabled',
      path: path.join(root, 'test-results/harness-preview/application-home.png')
    })
    const pages = [
      ['data', '数据盘'],
      ['notebook', 'Notebook'],
      ['figures', '图库'],
      ['memory', '记忆'],
      ['pipelines', '科研流程'],
      ['methods', '方法与证据'],
      ['runtime', '运行环境'],
      ['store', '订阅商城']
    ]
    for (const [id, label] of pages) {
      await rail.getByRole('button', { name: label, exact: true }).click()
      const panel = page.locator(`[data-omicos-page="${id}"]`)
      await panel.waitFor()
      await panel
        .getByRole('heading', { name: label, exact: true })
        .first()
        .waitFor()
      assert.equal(
        new URL(page.url()).pathname,
        '/',
        `${label} left the main application`
      )
      assert.equal(await page.locator('iframe[src*="/omicos/oss"]').count(), 0)
      await page.screenshot({
        animations: 'disabled',
        path: path.join(
          root,
          `test-results/harness-preview/application-${id}.png`
        )
      })
    }
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    await page
      .getByText('和 OmicOS 一起，探索下一次发现', { exact: true })
      .waitFor()
    if (
      await page.evaluate(() =>
        document.body.hasAttribute('data-ds-dark-theme')
      )
    ) {
      await rail
        .getByRole('button', { name: '切换深浅外观', exact: true })
        .click()
      await page.waitForFunction(
        () => !document.body.hasAttribute('data-ds-dark-theme')
      )
    }
    await rail
      .getByRole('button', { name: '切换深浅外观', exact: true })
      .click()
    await page.waitForFunction(() =>
      document.body.hasAttribute('data-ds-dark-theme')
    )
    await page.screenshot({
      animations: 'disabled',
      path: path.join(root, 'test-results/harness-preview/application-dark.png')
    })
    await rail
      .getByRole('button', { name: '切换深浅外观', exact: true })
      .click()
    await page.waitForFunction(
      () => !document.body.hasAttribute('data-ds-dark-theme')
    )
    await clickRailPage(rail, '科研流程')
    const flow = page.locator('[data-omicos-page="pipelines"]')
    const planDraft = flow.getByLabel('科研计划定义 JSON', { exact: true })
    const pipelineDraft = flow.getByLabel('Pipeline 定义 JSON', { exact: true })
    await planDraft.fill((await planDraft.inputValue()) + '\n')
    await pipelineDraft.fill((await pipelineDraft.inputValue()) + '\n')
    let confirmation
    page.once('dialog', async (dialog) => {
      confirmation = dialog.message()
      await dialog.dismiss()
    })
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    assert(
      confirmation?.includes('科研计划') &&
        confirmation.includes('Pipeline 定义')
    )
    assert(await flow.isVisible())
    page.once('dialog', (dialog) => dialog.accept())
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    await page.locator('[data-omicos-page="data"]').waitFor()
    const box = await page.locator('[data-omicos-frame]').boundingBox()
    assert(
      box.x >= 60 && box.width <= 1380,
      'OmicOS rail must reserve genuine frame space'
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    await page.locator('[data-omicos-page="data"]').waitFor()
    await page.waitForFunction(() => {
      const frame = document
        .querySelector('[data-omicos-frame]')
        .getBoundingClientRect()
      const navigation = document
        .querySelector('.omicos-rail')
        .getBoundingClientRect()
      return (
        Math.abs(frame.left) < 1 &&
        frame.width > innerWidth - 2 &&
        navigation.top > innerHeight - 85 &&
        Math.abs(navigation.bottom - innerHeight) < 2
      )
    })
    await rail.getByRole('button', { name: '订阅商城', exact: true }).click()
    await page.locator('[data-omicos-page="store"]').waitFor()
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    await page
      .locator('[data-omicos-page="data"]')
      .getByRole('heading', { name: '项目数据', exact: true })
      .waitFor()
    await page.screenshot({
      animations: 'disabled',
      path: path.join(
        root,
        'test-results/harness-preview/application-mobile.png'
      )
    })
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      'viewport overflow'
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        nativeApplication: true,
        scientificPanels: pages.length,
        navigationRoundTrip: true,
        iframe: false,
        modelAndCloudMocks: false,
        browserErrors: errors
      })
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
