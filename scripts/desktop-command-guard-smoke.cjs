/** Exercise the real Electron keyboard bridge against unsaved scientific editors. */
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
function dispatchNativeInput(keyCode) {
  const { BrowserWindow, app } = process
    .getBuiltinModule('module')
    .createRequire(process.cwd() + '/package.json')('electron')
  if (app.getName() !== 'OmicOS OSS') throw Error('Wrong native application')
  const window = BrowserWindow.getAllWindows().find((window) =>
    window.webContents.getURL().startsWith('dsh-app://app/')
  )
  if (!window) throw Error('Native renderer missing')
  if (!window.isFocused())
    throw Error('Activate the native OmicOS preview before this input test')
  if (keyCode === null) return true
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode,
    modifiers: ['meta']
  })
  window.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode,
    modifiers: ['meta']
  })
  return true
}
async function nativeKey(keyCode) {
  const endpoints = await (
    await fetch('http://127.0.0.1:9229/json/list')
  ).json()
  const socket = new WebSocket(endpoints[0].webSocketDebuggerUrl)
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error('Native input injection timed out')),
        10000
      )
      socket.onerror = reject
      socket.onmessage = (event) => {
        const reply = JSON.parse(event.data)
        if (reply.id === 1)
          reply.error || reply.result?.exceptionDetails
            ? reject(
                Error(
                  reply.result?.exceptionDetails?.exception?.description?.split(
                    '\n'
                  )[0] || 'Native input failed'
                )
              )
            : resolve()
      }
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(${dispatchNativeInput.toString()})(${JSON.stringify(keyCode)})`,
              returnByValue: true
            }
          })
        )
    })
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('dsh-app://app/'))
    assert(page)
    await nativeKey(null)
    const rail = page.getByRole('navigation', {
      name: 'OmicOS 功能导航',
      exact: true
    })
    await rail.getByRole('button', { name: '记忆', exact: true }).click()
    const main = page.locator('[data-omicos-page="memory"]')
    await main
      .getByLabel('记忆标题', { exact: true })
      .fill('NATIVE_MAIN_UNSAVED_FIXTURE')
    await main.getByLabel('记忆标题', { exact: true }).focus()
    // Controlled user choices avoid native OS modal automation; the command path stays real.
    await page.evaluate(() => {
      window.__omicosConfirmFixture = {
        original: window.confirm,
        accept: false,
        calls: []
      }
      window.confirm = (message) => {
        const fixture = window.__omicosConfirmFixture
        fixture.calls.push(String(message))
        return fixture.accept
      }
    })
    await nativeKey('N')
    await page.waitForFunction(
      () => window.__omicosConfirmFixture.calls.length === 1
    )
    assert(
      (
        await page.evaluate(() => window.__omicosConfirmFixture.calls[0])
      ).includes('记忆提案')
    )
    assert.equal(
      await main.getByLabel('记忆标题', { exact: true }).inputValue(),
      'NATIVE_MAIN_UNSAVED_FIXTURE'
    )
    await page.evaluate(() => {
      window.__omicosConfirmFixture.accept = true
    })
    await nativeKey('N')
    await main.waitFor({ state: 'detached' })
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const right = page.locator('[data-rightbar-col]')
    await right
      .locator('[data-sidebar-right-guide-entry="omicos-memory"]')
      .click()
    const memory = right.locator('[data-omicos-page="memory"]')
    const title = memory.getByLabel('记忆标题', { exact: true })
    await title.fill('NATIVE_TAB_UNSAVED_FIXTURE')
    await title.focus()
    await page.evaluate(() => {
      window.__omicosConfirmFixture.accept = false
      window.__omicosConfirmFixture.calls = []
    })
    await nativeKey('W')
    await page.waitForFunction(
      () => window.__omicosConfirmFixture.calls.length === 1
    )
    assert(
      (
        await page.evaluate(() => window.__omicosConfirmFixture.calls[0])
      ).includes('记忆提案')
    )
    assert.equal(await title.inputValue(), 'NATIVE_TAB_UNSAVED_FIXTURE')
    await page.evaluate(() => {
      window.__omicosConfirmFixture.accept = true
    })
    await nativeKey('W')
    await memory.waitFor({ state: 'detached' })
    console.log(
      JSON.stringify({
        input:
          'Electron webContents.sendInputEvent -> native keyboard bridge -> effective command registry',
        newSession: 'cancel retains main edit; accept leaves page',
        closeTab: 'cancel retains scoped tab edit; accept closes it',
        submittedMemoryProposals: 0
      })
    )
  } finally {
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        if (page.url().startsWith('dsh-app://app/'))
          await page.evaluate(() => {
            if (window.__omicosConfirmFixture) {
              window.confirm = window.__omicosConfirmFixture.original
              delete window.__omicosConfirmFixture
            }
          })
      }
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
