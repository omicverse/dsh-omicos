/** Inspect the running, isolated native development preview without model/account fixtures. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('dsh-app://app/'))
    assert(page, 'The official native desktop renderer must be running')
    await page.locator('.omicos-rail').waitFor()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.platform),
      'darwin'
    )
    const rail = page.getByRole('navigation', {
      name: 'OmicOS 功能导航',
      exact: true
    })
    const pages = [
      ['数据盘', 'data'],
      ['Notebook', 'notebook'],
      ['图库', 'figures'],
      ['记忆', 'memory'],
      ['科研流程', 'pipelines'],
      ['方法与证据', 'methods'],
      ['运行环境', 'runtime'],
      ['订阅商城', 'store']
    ]
    for (const [name, id] of pages) {
      await rail.getByRole('button', { name, exact: true }).click()
      await page.locator(`[data-omicos-page="${id}"]`).waitFor()
    }
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    assert.equal(await page.locator('iframe').count(), 0)
    assert.equal(await page.title(), 'OmicOS OSS')
    assert.deepEqual(errors, [])
    const output = path.resolve(
      __dirname,
      '../test-results/omicos-native-application.png'
    )
    await fs.mkdir(path.dirname(output), { recursive: true })
    await page.screenshot({ path: output, animations: 'disabled' })
    console.log(
      JSON.stringify({
        runtime: 'native dsh-app scheme, macOS preload',
        pages: pages.map(([, id]) => id),
        title: await page.title(),
        pageErrors: errors,
        screenshot: output
      })
    )
  } finally {
    // Disconnect CDP; leave the user's native preview window running.
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
