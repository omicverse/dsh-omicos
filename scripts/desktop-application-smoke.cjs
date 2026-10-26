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
        nativeShell,
        welcomeVerified,
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
