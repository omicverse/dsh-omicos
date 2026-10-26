/** Inspect the running, isolated native development preview without model/account fixtures. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { chromium } = require('playwright')
async function inspectNativeShell() {
  const endpoints = await (
    await fetch('http://127.0.0.1:9229/json/list')
  ).json()
  const socket = new WebSocket(endpoints[0].webSocketDebuggerUrl)
  let timer
  try {
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error('Native shell inspection timed out')),
        10000
      )
      socket.onerror = reject
      socket.onmessage = (event) => {
        const reply = JSON.parse(event.data)
        if (reply.id === 1) {
          if (reply.error || reply.result?.exceptionDetails)
            reject(Error('Native shell metadata could not be read'))
          else resolve(JSON.parse(reply.result.result.value))
        }
      }
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(()=>{const {app,Menu}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');return JSON.stringify({name:app.getName(),menus:Menu.getApplicationMenu()?.items.flatMap(i=>[i.label,...(i.submenu?.items.map(j=>j.label)||[])])})})()`,
              returnByValue: true
            }
          })
        )
    })
    const metadata = await response
    assert.equal(metadata.name, 'OmicOS OSS')
    assert(
      metadata.menus.some((label) =>
        /^(关于 OmicOS OSS|About OmicOS OSS)$/.test(label)
      )
    )
    assert(
      metadata.menus.some((label) =>
        /^(退出 OmicOS OSS|Quit OmicOS OSS)$/.test(label)
      )
    )
    return metadata
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}
;(async () => {
  const nativeShell = await inspectNativeShell()
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  try {
    const welcome = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().endsWith('/renderer/welcome.html'))
    let welcomeVerified = false
    if (welcome) {
      assert.equal(await welcome.title(), 'OmicOS OSS')
      assert.equal(
        await welcome.locator('input[type="password"]').inputValue(),
        ''
      )
      const local = welcome.getByRole('button', {
        name: /^(进入本地工作台|Open local workspace)$/
      })
      await local.waitFor()
      await welcome.screenshot({
        path: path.resolve(
          __dirname,
          '../test-results/omicos-native-welcome.png'
        ),
        animations: 'disabled'
      })
      await Promise.all([welcome.waitForEvent('close'), local.click()])
      welcomeVerified = true
    }
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
      const connected = page.waitForResponse(
        (response) =>
          response.url().endsWith('/omicos/oss/api/session') &&
          response.request().method() === 'GET'
      )
      await rail.getByRole('button', { name, exact: true }).click()
      assert(
        (await connected).ok(),
        `Native ${id} session connection must succeed`
      )
      const panel = page.locator(`[data-omicos-page="${id}"]`)
      await panel.waitFor()
      await panel
        .getByText('正在连接 OmicOS…', { exact: true })
        .waitFor({ state: 'hidden' })
      const headings = {
        data: '项目数据',
        figures: 'Figure Studio',
        memory: '记忆树',
        pipelines: 'Pipeline'
      }
      if (headings[id])
        await panel
          .getByRole('heading', { name: headings[id], exact: true })
          .waitFor()
      if (id === 'methods')
        await panel
          .getByText('科研 Skill 与方法版本库', { exact: true })
          .waitFor()
      if (id === 'notebook')
        await panel
          .getByRole('button', { name: '新建 Notebook', exact: true })
          .waitFor()
      if (id === 'runtime')
        await panel
          .getByText('基础 Python 运行时 · 按需下载', { exact: true })
          .waitFor()
      if (id === 'store') await panel.locator('.omicos-cloud-status').waitFor()
      assert.equal(
        await panel.locator('.omicos-panel-content > [role="alert"]').count(),
        0
      )
      const bounds = await panel.evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth
      }))
      assert(
        bounds.width > 0 && bounds.scroll <= bounds.width + 1,
        `Native ${id} must fit its panel without horizontal overflow`
      )
      await page.screenshot({
        path: path.resolve(
          __dirname,
          `../test-results/omicos-native-page-${id}.png`
        ),
        animations: 'disabled'
      })
    }
    await rail.getByRole('button', { name: '对话', exact: true }).click()
    assert.equal(await page.locator('iframe').count(), 0)
    assert.equal(await page.title(), 'OmicOS OSS')
    assert.deepEqual(errors, [])
    const originallyDark = await page.evaluate(() =>
      document.body.hasAttribute('data-ds-dark-theme')
    )
    const palette = []
    for (const dark of [false, true]) {
      if (
        (await page.evaluate(() =>
          document.body.hasAttribute('data-ds-dark-theme')
        )) !== dark
      )
        await rail
          .getByRole('button', { name: '切换深浅外观', exact: true })
          .click()
      await page.waitForFunction(
        (dark) => document.body.hasAttribute('data-ds-dark-theme') === dark,
        dark
      )
      const workspacePalette = await page
        .locator('[data-omicos-workspace-column]')
        .evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            background: style.backgroundColor,
            image: style.backgroundImage
          }
        })
      assert.equal(workspacePalette.image, 'none')
      assert.equal(
        workspacePalette.background,
        dark ? 'rgb(37, 40, 36)' : 'rgb(238, 244, 241)'
      )
      palette.push({ dark, ...workspacePalette })
      await page.screenshot({
        path: path.resolve(
          __dirname,
          `../test-results/omicos-native-${dark ? 'dark' : 'light'}.png`
        ),
        animations: 'disabled'
      })
    }
    if (
      (await page.evaluate(() =>
        document.body.hasAttribute('data-ds-dark-theme')
      )) !== originallyDark
    )
      await rail
        .getByRole('button', { name: '切换深浅外观', exact: true })
        .click()
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
        nativeShell,
        welcomeVerified,
        palette,
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
