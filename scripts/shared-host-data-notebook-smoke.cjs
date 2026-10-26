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
    const runs = []
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/notebook-run')
      )
        runs.push(request.postDataJSON())
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
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    const data = page.locator('[data-omicos-page="data"]')
    const name = `application-flow-${Date.now()}.csv`
    const bytes = Buffer.from('sample,value\na,10\nb,14\nc,18\n')
    await data.getByText('导入文件与断点续传', { exact: true }).click()
    await data
      .getByLabel('本机导入文件', { exact: true })
      .setInputFiles({ name, mimeType: 'text/csv', buffer: bytes })
    await data
      .getByRole('button', { name: '批准导入新文件', exact: true })
      .click()
    await data
      .locator('[data-upload-state]')
      .getByText('completed', { exact: true })
      .waitFor({ timeout: 60000 })
    const file = data
      .locator('.oss-data-file')
      .filter({ has: page.getByRole('button', { name, exact: true }) })
    await file.getByRole('button', { name, exact: true }).click()
    await data.locator('pre.oss-output').filter({ hasText: 'c,18' }).waitFor()
    await file
      .getByRole('button', { name: '准备加载代码', exact: true })
      .click()
    const prepared = await data
      .locator('section.oss-card')
      .filter({
        has: page.getByRole('heading', {
          name: '已准备 Python 导入代码',
          exact: true
        })
      })
      .locator('pre')
      .textContent()
    assert(prepared.includes(JSON.stringify(name)))
    assert.equal(
      runs.length,
      0,
      'Import and preparation must not execute analysis'
    )
    await rail.getByRole('button', { name: 'Notebook', exact: true }).click()
    const notebook = page.locator('[data-omicos-page="notebook"]')
    await notebook
      .getByLabel('分析语言', { exact: true })
      .selectOption('python')
    const creating = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notebook-create') &&
        response.request().method() === 'POST'
    )
    await notebook
      .getByRole('button', { name: '新建 Notebook', exact: true })
      .click()
    const created = await creating
    assert(created.ok())
    const document = await created.json()
    await page.waitForFunction(
      (id) =>
        window.document.querySelector('[aria-label="项目 Notebook"]')?.value ===
        id,
      document.id
    )
    const code =
      prepared + '\nprint("OMICOS_IMPORTED_CSV_SUM", int(table["value"].sum()))'
    await notebook
      .getByLabel('Notebook 单元 1 内容', { exact: true })
      .fill(code)
    assert.equal(runs.length, 0)
    const running = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notebook-run') &&
        response.request().postDataJSON()?.id === document.id
    )
    await notebook
      .getByRole('button', { name: '保存并批准运行单元 1', exact: true })
      .click()
    const executed = await running
    assert(executed.ok())
    const result = await executed.json()
    assert.equal(result.document.id, document.id)
    assert.equal(result.execution.code, code)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].confirmed, true)
    await notebook
      .locator('.oss-notebook .oss-output')
      .filter({ hasText: 'OMICOS_IMPORTED_CSV_SUM 42' })
      .waitFor({ timeout: 60000 })
    await notebook.getByText(result.execution.id, { exact: true }).waitFor()
    await rail.getByRole('button', { name: '数据盘', exact: true }).click()
    await data.getByRole('button', { name, exact: true }).click()
    await data.locator('pre.oss-output').filter({ hasText: 'c,18' }).waitFor()
    await rail.getByRole('button', { name: 'Notebook', exact: true }).click()
    await notebook
      .getByLabel('项目 Notebook', { exact: true })
      .selectOption(document.id)
    await notebook
      .locator('.oss-notebook .oss-output')
      .filter({ hasText: 'OMICOS_IMPORTED_CSV_SUM 42' })
      .waitFor()
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/application-data-notebook.png'
      ),
      animations: 'disabled'
    })
    await rail.getByRole('button', { name: '记忆', exact: true }).click()
    const memory = page.locator('[data-omicos-page="memory"]')
    await memory
      .getByLabel('记忆标题', { exact: true })
      .fill(`CSV sum fixture ${name}`)
    await memory
      .getByLabel('记忆正文', { exact: true })
      .fill(
        'Synthetic application acceptance fixture: the three imported values sum to 42; this is a software test, not a scientific conclusion.'
      )
    await memory.getByText('来源引用 JSON', { exact: true }).click()
    await memory
      .getByLabel('记忆来源 JSON', { exact: true })
      .fill(JSON.stringify([{ kind: 'execution', ref: result.execution.id }]))
    const proposing = page.waitForResponse(
      (response) =>
        response.url().endsWith('/memory-propose') &&
        response.request().method() === 'POST'
    )
    await memory
      .getByRole('button', { name: '保存记忆提案', exact: true })
      .click()
    const proposed = await proposing
    assert(proposed.ok())
    const proposal = await proposed.json()
    assert.equal(proposal.state, 'proposed')
    assert.equal(proposal.sources[0].verification, 'local-receipt')
    const confirming = page.waitForResponse(
      (response) =>
        response.url().endsWith('/memory-transition') &&
        response.request().method() === 'POST'
    )
    const effectiveResponse = page.waitForResponse(async (response) => {
      if (!response.url().includes('/memory-node?') || !response.ok())
        return false
      const view = await response.json()
      return view.node.id === proposal.id && view.node.state === 'confirmed'
    })
    await memory
      .getByRole('button', { name: '确认此版本', exact: true })
      .click()
    const confirmed = await confirming
    assert(confirmed.ok())
    assert.equal((await confirmed.json()).state, 'confirmed')
    const effective = await (await effectiveResponse).json()
    assert.equal(effective.node.id, proposal.id)
    assert.equal(effective.effective, true, JSON.stringify(effective.issues))
    await memory
      .getByText(/当前 r.*confirmed.*进入有权读取的 Agent 上下文/)
      .waitFor()
    await page.screenshot({
      path: path.resolve(
        __dirname,
        '../test-results/application-confirmed-memory.png'
      ),
      animations: 'disabled'
    })
    console.log(
      JSON.stringify({
        file: name,
        bytes: bytes.length,
        notebook: document.id,
        execution: result.execution.id,
        output: 'OMICOS_IMPORTED_CSV_SUM 42',
        runs: runs.length,
        confirmedMemory: proposal.id,
        resultSurvivesNavigation: true,
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
