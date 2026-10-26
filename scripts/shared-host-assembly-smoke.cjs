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
    const workspacePath = path.resolve(
      __dirname,
      '../test-results/session-scope-fixture'
    )
    await fs.mkdir(workspacePath, { recursive: true })
    const registration = await page.evaluate(async (workspacePath) => {
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
    assert.equal(registration.body.result.ok, true)
    const picker = page.getByRole('button', { name: '选择工作区', exact: true })
    await picker.click()
    await page
      .getByRole('menuitem', { name: 'session-scope-fixture', exact: true })
      .click()
    const fixture = JSON.parse(
      await fs.readFile(
        path.resolve(
          __dirname,
          '../test-results/application-figure-fixture.json'
        ),
        'utf8'
      )
    )
    assert.equal(
      fixture.review,
      'approved',
      'Run test:shared-host-figure first to create the real evidence fixture'
    )
    await rail.getByRole('button', { name: '图库', exact: true }).click()
    const assembly = page.locator('article').filter({
      has: page.getByText('Figure Studio 多面板组图', { exact: true })
    })
    await assembly
      .getByText('Figure Studio 多面板组图', { exact: true })
      .click()
    await assembly
      .getByLabel('组图原图', { exact: true })
      .selectOption(fixture.figure)
    await assembly
      .getByRole('button', { name: '添加原图面板', exact: true })
      .click()
    await assembly
      .getByRole('button', { name: '添加原图面板', exact: true })
      .click()
    const layout = JSON.parse(
      await assembly.getByLabel('组图布局 JSON', { exact: true }).inputValue()
    )
    assert.equal(layout.panels.length, 2)
    assert.deepEqual(
      layout.panels.map((p) => p.label),
      ['A', 'B']
    )
    assert(
      layout.panels.every(
        (p) => p.figureId === fixture.figure && p.figureRevision === 2
      )
    )
    await assembly
      .getByLabel('组图标题', { exact: true })
      .fill(`Synthetic repeated-panel assembly ${Date.now()}`)
    await assembly
      .getByLabel('组图图注', { exact: true })
      .fill(
        'Software fixture: A and B intentionally repeat the same synthetic curve to test layout and pinned source handling. Not independent evidence.'
      )
    const saving = page.waitForResponse(
      (r) =>
        r.url().endsWith('/assembly-save') && r.request().method() === 'POST'
    )
    await assembly
      .getByRole('button', { name: '保存组图草案与来源版本', exact: true })
      .click()
    const savedResponse = await saving
    assert(savedResponse.ok())
    const saved = await savedResponse.json()
    assert.deepEqual(saved.layout, layout)
    await assembly
      .getByLabel('组图人工复核说明', { exact: true })
      .fill(
        'Checked saved layout A/B, intentional duplicate source, current approved figure revision and explanation.'
      )
    await assembly
      .getByRole('checkbox', { name: '确认组图复核', exact: true })
      .check()
    const reviewing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/assembly-review') && r.request().method() === 'POST'
    )
    await assembly
      .getByRole('button', { name: '复核通过此组图', exact: true })
      .click()
    const reviewedResponse = await reviewing
    assert(reviewedResponse.ok())
    const reviewed = await reviewedResponse.json()
    assert.equal(reviewed.review.state, 'approved')
    await assembly
      .locator('[data-assembly-state]')
      .getByText('approved', { exact: true })
      .waitFor()
    const preview = assembly.getByRole('img', {
      name: `保存的组图预览 r${reviewed.revision}`,
      exact: true
    })
    await preview.waitFor()
    assert.equal(await preview.locator('image').count(), 2)
    for (const image of await preview.locator('image').all()) {
      const href = await image.getAttribute('href')
      const bytes = await page.request.get(new URL(href, page.url()).href)
      assert(bytes.ok())
      assert.equal(
        require('node:crypto')
          .createHash('sha256')
          .update(await bytes.body())
          .digest('hex'),
        fixture.sha256
      )
    }
    const svgUrl = await assembly
      .getByRole('link', { name: '下载保存版本 SVG ↗', exact: true })
      .getAttribute('href')
    const svg = await page.request.get(new URL(svgUrl, page.url()).href)
    assert(svg.ok())
    const text = await svg.text()
    assert(text.includes('data:image/png;base64,'))
    assert(text.includes('>A</text>') && text.includes('>B</text>'))
    await preview.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/application-approved-assembly.png'
      ),
      animations: 'disabled'
    })
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        assembly: reviewed.id,
        revision: reviewed.revision,
        state: reviewed.review.state,
        panels: layout.panels.length,
        sourceFigure: fixture.figure,
        sourceSha256: fixture.sha256,
        svgBytes: Buffer.byteLength(text),
        errors
      })
    )
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
