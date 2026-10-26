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
    await rail.getByRole('button', { name: 'Notebook', exact: true }).click()
    const notebook = page.locator('[data-omicos-page="notebook"]')
    await notebook
      .getByLabel('分析语言', { exact: true })
      .selectOption('python')
    const creating = page.waitForResponse(
      (r) =>
        r.url().endsWith('/notebook-create') && r.request().method() === 'POST'
    )
    await notebook
      .getByRole('button', { name: '新建 Notebook', exact: true })
      .click()
    const document = await (await creating).json()
    await page.waitForFunction(
      (id) =>
        window.document.querySelector('[aria-label="项目 Notebook"]')?.value ===
        id,
      document.id
    )
    const code =
      'import matplotlib.pyplot as plt\nplt.figure()\nplt.plot([0, 1, 2], [0, 1, 4])\nplt.title("Synthetic OmicOS acceptance fixture")\nprint("OMICOS_FIGURE_CREATED")'
    await notebook
      .getByLabel('Notebook 单元 1 内容', { exact: true })
      .fill(code)
    const running = page.waitForResponse(
      (r) =>
        r.url().endsWith('/notebook-run') &&
        r.request().postDataJSON()?.id === document.id
    )
    await notebook
      .getByRole('button', { name: '保存并批准运行单元 1', exact: true })
      .click()
    const executed = await running
    assert(executed.ok())
    const accepted = await executed.json()
    const receiptUrl = executed
      .url()
      .replace(
        /notebook-run$/,
        `execution?language=python&id=${encodeURIComponent(accepted.execution.id)}`
      )
    const states = []
    let execution
    const deadline = Date.now() + 60000
    do {
      const receipt = await page.request.get(receiptUrl)
      assert(receipt.ok())
      execution = await receipt.json()
      if (states.at(-1) !== execution.state) states.push(execution.state)
      if (
        ['succeeded', 'failed', 'canceled', 'interrupted'].includes(
          execution.state
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    const result = { execution }
    console.log(
      JSON.stringify({ observedStates: states, execution: execution.id })
    )
    assert.equal(result.execution.code, code)
    assert.equal(result.execution.state, 'succeeded')
    const artifact = result.execution.artifacts.find(
      (a) => a.mime === 'image/png'
    )
    assert(artifact, 'The real kernel must produce a PNG receipt')
    await notebook
      .locator('.oss-notebook .oss-output')
      .filter({ hasText: 'OMICOS_FIGURE_CREATED' })
      .waitFor()
    await rail.getByRole('button', { name: '图库', exact: true }).click()
    const studio = page.getByRole('article', {
      name: 'Figure Studio',
      exact: true
    })
    const candidate = studio.getByLabel('选择实际图形产物', { exact: true })
    await page.waitForFunction(
      (id) =>
        Array.from(
          window.document.querySelector('[aria-label="选择实际图形产物"]')
            ?.options || []
        ).some((o) => {
          try {
            return JSON.parse(o.value).artifactId === id
          } catch {
            return false
          }
        }),
      artifact.id
    )
    const source = await candidate
      .locator('option')
      .evaluateAll(
        (options, id) =>
          options.find((o) => JSON.parse(o.value).artifactId === id)?.value,
        artifact.id
      )
    assert.equal(JSON.parse(source).executionId, result.execution.id)
    await candidate.selectOption(source)
    await studio
      .getByLabel('图形标题', { exact: true })
      .fill(`Synthetic acceptance figure ${Date.now()}`)
    await studio
      .getByLabel('图形说明', { exact: true })
      .fill(
        'Software acceptance fixture using synthetic points. No scientific inference.'
      )
    const saving = page.waitForResponse(
      (r) => r.url().endsWith('/figure-save') && r.request().method() === 'POST'
    )
    await studio
      .getByRole('button', { name: '保存图形草稿', exact: true })
      .click()
    const savedResponse = await saving
    assert(savedResponse.ok())
    const saved = await savedResponse.json()
    assert.equal(saved.source.executionId, result.execution.id)
    assert.equal(saved.artifact.sha256, artifact.sha256)
    await studio
      .getByRole('status')
      .filter({ hasText: '原图字节已核对' })
      .waitFor()
    const image = studio.locator('.oss-figure-proof img')
    await image.waitFor()
    await image.evaluate(async (img) => {
      await img.decode()
      if (!img.naturalWidth) throw Error('Figure did not decode')
    })
    const imageUrl = await studio
      .getByRole('link', { name: '下载原图 ↗', exact: true })
      .getAttribute('href')
    const downloaded = await page.request.get(
      new URL(imageUrl, page.url()).href
    )
    assert(downloaded.ok())
    const digest = require('node:crypto')
      .createHash('sha256')
      .update(await downloaded.body())
      .digest('hex')
    assert.equal(digest, artifact.sha256)
    await studio
      .getByLabel('人工审阅意见', { exact: true })
      .fill(
        'Checked the synthetic curve, source execution, caption and actual PNG bytes for software acceptance.'
      )
    await studio
      .getByRole('checkbox', {
        name: '我已核对当前已保存版本的原图、说明和来源',
        exact: true
      })
      .check()
    const reviewing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/figure-review') && r.request().method() === 'POST'
    )
    await studio
      .getByRole('button', { name: '确认通过此图', exact: true })
      .click()
    const reviewed = await reviewing
    assert(reviewed.ok())
    const final = await reviewed.json()
    assert.equal(final.review.state, 'approved')
    assert.equal(final.id, saved.id)
    await studio.locator('.oss-figure-proof').screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/application-approved-figure.png'
      ),
      animations: 'disabled'
    })
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        notebook: document.id,
        execution: result.execution.id,
        artifact: artifact.id,
        figure: saved.id,
        sha256: digest,
        review: 'approved',
        actualPngDecoded: true,
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
