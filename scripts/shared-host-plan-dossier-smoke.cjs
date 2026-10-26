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
    await rail.getByRole('button', { name: '科研流程', exact: true }).click()
    const plans = page.getByRole('article', { name: '科研计划', exact: true })
    const definition = {
      title: `Synthetic figure acceptance ${Date.now()}`,
      objective:
        'Verify a synthetic local figure receipt and preserve owner assessment; no scientific inference.',
      steps: [
        {
          id: 'verify-figure',
          title: 'Inspect synthetic figure receipt',
          inputs: ['Synthetic Matplotlib cell'],
          outputs: ['PNG with execution and content digest'],
          methods: [
            'Owner inspection of synthetic curve and exact artifact digest'
          ],
          risk: 'Software fixture only; no external data or scientific claim.',
          acceptance:
            'Execution succeeded and produced a local PNG; owner checks the rendered curve.'
        }
      ]
    }
    await plans
      .getByLabel('科研计划定义 JSON', { exact: true })
      .fill(JSON.stringify(definition))
    const saving = page.waitForResponse(
      (r) =>
        r.url().endsWith('/research-plan-propose') &&
        r.request().method() === 'POST'
    )
    await plans
      .getByRole('button', { name: '保存科研计划草案', exact: true })
      .click()
    const savedResponse = await saving
    assert(savedResponse.ok())
    const saved = await savedResponse.json()
    assert.equal(saved.status, 'draft')
    await plans
      .getByLabel('科研计划决定说明', { exact: true })
      .fill(
        'Approve only this synthetic software acceptance plan; execution still requires separate approval.'
      )
    const approving = page.waitForResponse(
      (r) =>
        r.url().endsWith('/research-plan-decide') &&
        r.request().postDataJSON().decision.action === 'approve'
    )
    await plans
      .getByRole('button', { name: '批准此版本科研计划', exact: true })
      .click()
    assert.equal((await (await approving).json()).status, 'approved')
    await plans
      .getByLabel('科研计划决定说明', { exact: true })
      .fill(
        'Inspected the synthetic curve, completed execution receipt and PNG digest.'
      )
    await plans.getByText('选择任务验收的执行证据', { exact: true }).click()
    await plans
      .getByLabel('计划执行证据编号', { exact: true })
      .fill(fixture.execution)
    const completing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/research-plan-decide') &&
        r.request().postDataJSON().decision.action === 'complete'
    )
    await plans
      .getByRole('button', { name: '凭执行证据确认完成', exact: true })
      .click()
    const completeResponse = await completing
    assert(completeResponse.ok())
    const complete = await completeResponse.json()
    assert.equal(complete.assessments[0].state, 'completed')
    assert.equal(
      complete.assessments[0].evidence[0].executionId,
      fixture.execution
    )
    assert(
      complete.assessments[0].evidence[0].artifacts.some(
        (a) => a.sha256 === fixture.sha256
      )
    )
    await rail.getByRole('button', { name: '方法与证据', exact: true }).click()
    const dossier = page.getByRole('article', {
      name: '项目科研档案',
      exact: true
    })
    await dossier.locator('summary').first().click()
    await dossier
      .getByLabel('科研档案标题', { exact: true })
      .fill(`Synthetic evidence dossier ${Date.now()}`)
    await dossier
      .getByLabel('科研档案发现', { exact: true })
      .fill(
        'The local synthetic plotting workflow produced a PNG whose downloaded bytes matched the recorded digest.'
      )
    await dossier
      .getByLabel('科研档案局限', { exact: true })
      .fill(
        'Software acceptance fixture only. No scientific interpretation or external data validation.'
      )
    const sources = [
      { kind: 'execution', id: fixture.execution },
      { kind: 'notebook', id: fixture.notebook },
      { kind: 'figure', id: fixture.figure },
      { kind: 'plan', id: saved.id }
    ]
    await dossier
      .getByLabel('科研档案来源 JSON', { exact: true })
      .fill(JSON.stringify(sources))
    const capturing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/dossier-save') && r.request().method() === 'POST'
    )
    await dossier
      .getByRole('button', { name: '批准采集证据并保存草案', exact: true })
      .click()
    const capturedResponse = await capturing
    assert(capturedResponse.ok())
    const captured = await capturedResponse.json()
    assert.equal(captured.state, 'draft')
    assert.deepEqual(
      captured.sources.map((pin) => pin.source),
      sources
    )
    await dossier
      .getByLabel('科研档案复核说明', { exact: true })
      .fill(
        'Checked the captured execution, Notebook, reviewed figure and accepted plan snapshots for software acceptance.'
      )
    const reviewing = page.waitForResponse(
      (r) =>
        r.url().endsWith('/dossier-review') && r.request().method() === 'POST'
    )
    await dossier
      .getByRole('button', { name: '复核此档案版本', exact: true })
      .click()
    const reviewedResponse = await reviewing
    assert(reviewedResponse.ok())
    const reviewed = await reviewedResponse.json()
    assert.equal(reviewed.state, 'reviewed')
    assert.equal(reviewed.review.checks.length, 4)
    await dossier
      .locator('[data-dossier-state]')
      .getByText('reviewed', { exact: true })
      .waitFor()
    const exportUrl = await dossier
      .getByRole('link', { name: '导出当前档案快照 ↗', exact: true })
      .getAttribute('href')
    const exported = await page.request.get(new URL(exportUrl, page.url()).href)
    assert(exported.ok())
    const exportedDocument = await exported.json()
    assert.equal(exportedDocument.schema, 'omicos.dossier/1')
    assert.equal(exportedDocument.entry.digest, reviewed.digest)
    assert.deepEqual(errors, [])
    await dossier
      .getByRole('region', { name: '科研档案详情', exact: true })
      .screenshot({
        path: path.resolve(
          __dirname,
          '../test-results/application-reviewed-dossier.png'
        ),
        animations: 'disabled'
      })
    console.log(
      JSON.stringify({
        plan: saved.id,
        planAssessment: 'completed',
        execution: fixture.execution,
        dossier: reviewed.id,
        dossierState: reviewed.state,
        pinnedSources: reviewed.sources.length,
        exportDigest: reviewed.digest,
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
