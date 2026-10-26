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
    const stamp = Date.now()
    await rail.getByRole('button', { name: '方法与证据', exact: true }).click()
    const methods = page.getByRole('article', {
      name: '科研方法库',
      exact: true
    })
    await methods.getByText('科研 Skill 与方法版本库', { exact: true }).click()
    const pack = {
      schema: 'omicos.methods/1',
      methods: [
        {
          key: `acceptance.sum-${stamp}`,
          version: '1.0.0',
          title: `Synthetic sum method ${stamp}`,
          description:
            'Local software acceptance fixture, not a scientific method validation.',
          body: 'Add two integers in a local isolated kernel. Stop if values are not integers. No external data, network or installation.',
          authors: ['OmicOS OSS acceptance fixture'],
          sources: [],
          license: {
            id: 'CC0-1.0',
            text: 'This synthetic test text is dedicated to the public domain.'
          }
        }
      ]
    }
    await methods
      .getByLabel('科研方法包 JSON', { exact: true })
      .fill(JSON.stringify(pack))
    const importing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/method-import') && r.request().method() === 'POST'
    )
    await methods
      .getByRole('button', { name: '批准导入待审阅方法包', exact: true })
      .click()
    const imported = await importing
    assert(imported.ok())
    const [method] = await imported.json()
    assert.equal(method.review.state, 'draft')
    await methods
      .getByLabel('科研方法审阅说明', { exact: true })
      .fill(
        'Reviewed synthetic local acceptance fixture text; publishing allows exact version pinning only.'
      )
    const publishing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/method-review') && r.request().method() === 'POST'
    )
    await methods
      .getByRole('button', { name: '发布此版本供固定引用', exact: true })
      .click()
    const published = await publishing
    assert(published.ok())
    assert.equal((await published.json()).review.state, 'published')
    const referencing = page.waitForResponse(
      (r) => r.url().includes('/method-reference?') && r.ok()
    )
    await methods
      .getByRole('button', { name: '读取精确 Pipeline 固定引用', exact: true })
      .click()
    const reference = await (await referencing).json()
    await rail.getByRole('button', { name: '科研流程', exact: true }).click()
    const pipeline = page.getByRole('article', {
      name: 'Pipeline 工作流',
      exact: true
    })
    const definition = {
      title: `Synthetic gated sum ${stamp}`,
      language: 'python',
      parameters: {},
      inputs: [],
      references: [reference],
      steps: [
        {
          id: 'prepare',
          title: 'Prepare local value',
          code: 'value = 40\nprint("OMICOS_PIPELINE_PREPARED", value)'
        },
        {
          id: 'report',
          title: 'Approve result',
          gate: true,
          code: 'print("OMICOS_PIPELINE_RESULT", value + 2)'
        }
      ]
    }
    await pipeline
      .getByLabel('Pipeline 定义 JSON', { exact: true })
      .fill(JSON.stringify(definition))
    const defining = page.waitForResponse(
      (r) =>
        r.url().endsWith('/pipeline-define') && r.request().method() === 'POST'
    )
    await pipeline
      .getByRole('button', { name: '保存固定定义', exact: true })
      .click()
    const defined = await defining
    assert(defined.ok())
    const saved = await defined.json()
    assert.deepEqual(saved.references, [reference])
    const starting = page.waitForResponse(
      (r) =>
        r.url().endsWith('/pipeline-start') && r.request().method() === 'POST'
    )
    await pipeline
      .getByRole('button', { name: '批准运行此定义', exact: true })
      .click()
    const started = await starting
    assert(started.ok())
    const run = await started.json()
    assert.equal(run.definitionId, saved.id)
    await pipeline
      .locator('[data-pipeline-state]')
      .getByText('waiting', { exact: true })
      .waitFor({ timeout: 60000 })
    await pipeline.getByText(/OMICOS_PIPELINE_PREPARED 40/).waitFor()
    assert.equal(
      await pipeline.getByText(/OMICOS_PIPELINE_RESULT 42/).count(),
      0,
      'Gated report must not run before owner continuation'
    )
    const continuing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/pipeline-control') &&
        r.request().postDataJSON().action === 'continue'
    )
    await pipeline
      .getByRole('button', { name: '批准此阶段并继续', exact: true })
      .click()
    const continued = await continuing
    assert(continued.ok())
    assert.equal(continued.request().postDataJSON().confirmed, true)
    await pipeline
      .locator('[data-pipeline-state]')
      .getByText('succeeded', { exact: true })
      .waitFor({ timeout: 60000 })
    await pipeline.getByText(/OMICOS_PIPELINE_RESULT 42/).waitFor()
    await page.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/application-method-pipeline.png'
      ),
      animations: 'disabled'
    })
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        method: method.id,
        methodPublished: true,
        pinnedReference: reference,
        definition: saved.id,
        run: run.id,
        gate: 'explicitly continued',
        output: 'OMICOS_PIPELINE_RESULT 42',
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
