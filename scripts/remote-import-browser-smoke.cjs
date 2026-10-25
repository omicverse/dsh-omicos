/** Real HTTPS source, owner workbench, durable pause/reload/Range resume; no scientific execution. */
const { chromium } = require('playwright')
const https = require('node:https')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')
;(async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'oss-remote-browser-')
  )
  let child, browser, source
  const connections = new Set(),
    seen = []
  const output = path.resolve(
    process.env.OMICOS_SCREENSHOT_DIR || 'test-results/oss-browser'
  )
  const bytes = Buffer.alloc(4194304 + 73, 97)
  bytes.set(Buffer.from('sample,value\n'))
  const sha = createHash('sha256').update(bytes).digest('hex')
  try {
    const key = path.join(directory, 'fixture.key'),
      cert = path.join(directory, 'fixture.crt')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=OmicOS local test source',
        '-addext',
        'subjectAltName=IP:127.0.0.1'
      ],
      { stdio: 'ignore' }
    )
    source = https.createServer(
      { key: await fs.readFile(key), cert: await fs.readFile(cert) },
      (request, response) => {
        seen.push({
          range: request.headers.range,
          ifRange: request.headers['if-range'],
          authorization: request.headers.authorization,
          cookie: request.headers.cookie
        })
        const offset = request.headers.range
          ? Number(request.headers.range.match(/bytes=(\d+)-/)?.[1])
          : 0
        response.writeHead(offset ? 206 : 200, {
          'content-length': bytes.length - offset,
          etag: '"fixture-source-v1"',
          ...(offset
            ? {
                'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`
              }
            : {})
        })
        if (offset) response.end(bytes.subarray(offset))
        else response.write(bytes.subarray(0, 4194304))
      }
    )
    source.on('connection', (socket) => {
      connections.add(socket)
      socket.once('close', () => connections.delete(socket))
    })
    await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve))
    const sourceUrl = `https://127.0.0.1:${source.address().port}/dataset?signature=fixture-secret`
    child = spawn(
      process.execPath,
      [
        'lib/oss/cli.js',
        '--workspace',
        path.join(directory, 'project'),
        '--state-dir',
        path.join(directory, 'state'),
        '--python',
        '/must-not-run-for-remote-import',
        '--port',
        '0'
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const launch = await new Promise((resolve, reject) => {
      let text = '',
        errors = ''
      const timer = setTimeout(
        () => reject(Error('Host startup timed out: ' + errors)),
        15000
      )
      child.stdout.on('data', (chunk) => {
        text += chunk
        const found = text.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/)
        if (found) {
          clearTimeout(timer)
          resolve(found[0])
        }
      })
      child.stderr.on(
        'data',
        (chunk) => (errors = (errors + chunk).slice(-4000))
      )
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(Error('Host exited ' + code + ': ' + errors))
      })
    })
    browser = await chromium.launch({
      headless: true,
      ...(process.env.OMICOS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OMICOS_BROWSER_EXECUTABLE }
        : {})
    })
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1080 }
      }),
      errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(launch)
    const pane = page.getByLabel('远程数据导入', { exact: true })
    await pane.getByText('从远程地址导入数据', { exact: true }).click()
    await pane
      .getByLabel('远程数据 HTTPS 地址', { exact: true })
      .fill(sourceUrl)
    await pane
      .getByLabel('远程数据目标文件名', { exact: true })
      .fill('remote-data.csv')
    await pane
      .getByLabel('远程数据预期字节数', { exact: true })
      .fill(String(bytes.length))
    await pane.getByLabel('远程数据预期 SHA-256', { exact: true }).fill(sha)
    assert.equal(
      await pane
        .getByRole('button', { name: '批准下载新数据文件', exact: true })
        .isEnabled(),
      false
    )
    await pane.getByLabel('批准访问远程数据来源', { exact: true }).check()
    await pane
      .getByRole('button', { name: '批准下载新数据文件', exact: true })
      .click()
    await pane
      .locator('[data-remote-import-received]')
      .filter({ hasText: /^4194304$/ })
      .waitFor({ timeout: 60000 })
    const id = await pane
      .getByLabel('远程导入记录', { exact: true })
      .inputValue()
    await pane
      .getByRole('button', { name: '暂停远程下载', exact: true })
      .click()
    await pane
      .locator('[data-remote-import-state]')
      .filter({ hasText: /^paused$/ })
      .waitFor()
    assert.equal(seen.length, 1)
    await page.reload()
    await pane.getByText('从远程地址导入数据', { exact: true }).click()
    await pane.getByLabel('远程导入完整编号', { exact: true }).fill(id)
    await pane
      .getByRole('button', { name: '读取指定远程导入', exact: true })
      .click()
    await pane
      .locator('[data-remote-import-state]')
      .filter({ hasText: /^paused$/ })
      .waitFor()
    assert.equal(seen.length, 1)
    await pane.getByLabel('批准访问远程数据来源', { exact: true }).check()
    await pane
      .getByRole('button', { name: '批准恢复原来源下载', exact: true })
      .click()
    await pane
      .locator('[data-remote-import-state]')
      .filter({ hasText: /^completed$/ })
      .waitFor({ timeout: 60000 })
    await pane
      .locator('[data-remote-import-sha256]')
      .filter({ hasText: sha })
      .waitFor()
    await page
      .locator('.oss-data-file')
      .filter({ hasText: 'remote-data.csv' })
      .waitFor()
    assert.equal(
      createHash('sha256')
        .update(
          await fs.readFile(path.join(directory, 'project', 'remote-data.csv'))
        )
        .digest('hex'),
      sha
    )
    assert.equal(seen.length, 2)
    assert.equal(seen[1].range, 'bytes=4194304-')
    assert.equal(seen[1].ifRange, '"fixture-source-v1"')
    assert(seen.every((request) => !request.authorization && !request.cookie))
    assert(!(await pane.innerText()).includes('fixture-secret'))
    const snapshot = await page.evaluate(async () => {
      const session = await (await fetch('/omicos/oss/api/session')).json()
      return await (
        await fetch(
          `/omicos/oss/api/project/${session.projects[0].id}/snapshot`
        )
      ).json()
    })
    assert.equal(snapshot.kernel.state, 'cold')
    assert.equal(snapshot.executions.length, 0)
    await fs.mkdir(output, { recursive: true })
    await pane.screenshot({ path: path.join(output, 'remote-import.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await pane.screenshot({
      path: path.join(output, 'remote-import-mobile.png')
    })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        source: 'actual trusted local HTTPS fixture; no insecure TLS bypass',
        transfer:
          'durable 4 MiB pause, page reload without network, exact Range/If-Range resume',
        publication:
          'complete SHA-256, source checksum and actual project bytes match',
        privacy:
          'no account authorization/cookies sent; query omitted in receipt display',
        execution: 'kernel remains cold with no execution receipts',
        pageErrors: errors,
        mobile: 'expanded remote import pane has no horizontal overflow',
        screenshots: output
      })
    )
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(timer)
    }
    for (const socket of connections) socket.destroy()
    if (source) await new Promise((resolve) => source.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
