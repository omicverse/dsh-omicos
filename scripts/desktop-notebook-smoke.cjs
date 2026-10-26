/** Run explicit harmless Notebook computations in the isolated native developer preview. */
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('dsh-app://app/'))
    if (!page) throw Error('Start the isolated native OmicOS preview first')
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page
      .getByRole('navigation', { name: 'OmicOS 功能导航', exact: true })
      .getByRole('button', { name: 'Notebook', exact: true })
      .click()
    const notebook = page.locator('[data-omicos-page="notebook"]')
    const results = []
    for (const [language, code, expected] of [
      [
        'python',
        'print("OMICOS_NATIVE_PYTHON_42", 6 * 7)',
        'OMICOS_NATIVE_PYTHON_42 42'
      ],
      ['r', 'cat("OMICOS_NATIVE_R_4", mean(c(2, 4, 6)))', 'OMICOS_NATIVE_R_4 4']
    ]) {
      await notebook
        .getByLabel('分析语言', { exact: true })
        .selectOption(language)
      const createdResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/notebook-create') &&
          response.request().method() === 'POST'
      )
      await notebook
        .getByRole('button', { name: '新建 Notebook', exact: true })
        .click()
      const created = await createdResponse
      assert(created.ok())
      const document = await created.json()
      assert.equal(document.language, language)
      await page.waitForFunction(
        (id) =>
          window.document.querySelector('[aria-label="项目 Notebook"]')
            ?.value === id,
        document.id
      )
      assert.equal(
        await notebook.locator('.oss-notebook .oss-output').count(),
        0
      )
      await notebook
        .getByLabel('Notebook 单元 1 内容', { exact: true })
        .fill(code)
      const executedResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/notebook-run') &&
          response.request().method() === 'POST' &&
          response.request().postDataJSON().id === document.id
      )
      await notebook
        .getByRole('button', { name: '保存并批准运行单元 1', exact: true })
        .click()
      const executed = await executedResponse
      assert(executed.ok())
      assert.equal(executed.request().postDataJSON().confirmed, true)
      const result = await executed.json()
      assert.equal(result.document.id, document.id)
      assert.equal(result.execution.language, language)
      assert.equal(result.execution.code, code)
      await notebook.getByText(result.execution.id, { exact: true }).waitFor()
      await notebook
        .locator('.oss-notebook .oss-output')
        .filter({ hasText: expected })
        .waitFor({ timeout: 60000 })
      results.push({
        language,
        output: expected,
        notebook: document.id,
        execution: result.execution.id
      })
    }
    if (errors.length) throw Error(errors.join('\n'))
    const screenshot = path.resolve(
      __dirname,
      '../test-results/omicos-native-notebook-r.png'
    )
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    console.log(
      JSON.stringify({
        runtime: 'actual Electron custom scheme, existing Notebook approval',
        results,
        pageErrors: errors,
        screenshot
      })
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
