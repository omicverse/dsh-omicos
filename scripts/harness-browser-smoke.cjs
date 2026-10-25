/** Full published Harness profile, synthetic local model only; never reads real model keys. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const version = '0.2.1-rc.3';
const root = path.resolve(__dirname, '..');
const redact = text => text.replace(/([?&](?:token|omicos_token)=)[^\s&]+/g, '$1[redacted]');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', `--package=@deepseek-ai/dsh@${version}`, 'dsh'];
function run(arguments_, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, ...arguments_], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const capture = chunk => { output = (output + chunk).slice(-12000) };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Harness profile setup failed (${code}): ${redact(output)}`)) });
  });
}
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omicos-harness-browser-'));
  const workspace = path.join(directory, 'research'); const marker = path.join(workspace, 'approved-by-ui.txt');
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL', 'SystemRoot', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  env.DSH_HOME = path.join(directory, 'dsh'); env.DSH_AGENTS_HOME = path.join(directory, 'agents');
  env.DEEPSEEK_API_KEY = 'synthetic-local-model-key';
  let child, browser, issuedTool = false; const requests = []; const errors = [];
  const model = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text || '{}'); requests.push(body);
      const scientific = body.tools?.some(tool => tool.name === 'omicos_run_python');
      const tool = scientific && !issuedTool; if (tool) issuedTool = true;
      const events = [
        { type: 'message_start', message: { id: `mock_${requests.length}`, model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_scientific', name: 'omicos_run_python', input: { code: 'from pathlib import Path\nPath("approved-by-ui.txt").write_text("42")\nprint(42)', operation_id: 'harness-browser-scientific' } } : { type: 'text', text: '' } },
        ...tool ? [] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OmicOS mock Scientist connected.' } }],
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch { response.writeHead(500); response.end() }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    console.log('Preparing an isolated published Harness Web profile…');
    await run(['plugin', '--profile', 'web', 'add', root], env, directory);
    const config = [
      '- id: omicos', '  config:', '    backend: oss', `    workspace: ${JSON.stringify(workspace)}`,
      `    stateDir: ${JSON.stringify(path.join(directory, 'state'))}`, `    python: ${JSON.stringify(process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3')}`,
      '    autoStart: false', '    upstreamBaseUrl: http://127.0.0.1:9',
      '- id: llm-deepseek', '  config:', `    baseURL: http://127.0.0.1:${model.address().port}`, '    reasoningEffort: off',
      '- id: llm-deepseek-account', '  disabled: true', '',
    ].join('\n');
    await fs.writeFile(path.join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'), config);
    child = spawn(command, [...args, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000) });
    const launch = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error(`Harness startup timeout: ${redact(diagnostics)}`)), 45000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]+/); if (match) { clearTimeout(timer); resolve(match[0]) } });
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(Error(`Harness exited ${code}: ${redact(diagnostics)}`)) });
    });
    const origin = new URL(launch).origin;
    for (const route of ['/api', '/omicos/oss', '/omicos/oss/api/session', '/omicos/oss/workbench.js']) assert.equal((await fetch(origin + route, { redirect: 'manual' })).status, 401, route);
    browser = await chromium.launch({ headless: true, ...(process.env.OMICOS_BROWSER_EXECUTABLE ? { executablePath: process.env.OMICOS_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(launch); await page.goto(origin + '/omicos/oss');
    await page.evaluate(async () => {
      const session = await (await fetch('/omicos/oss/api/session')).json(); const prefix = `/omicos/oss/api/project/${session.projects[0].id}/`
      const post = async (path, data) => { const response = await fetch(prefix + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': session.csrf }, body: JSON.stringify(data) }); const body = await response.json(); if (!response.ok) throw Error(JSON.stringify(body)); return body }
      for (const [index, text, scope, confirmed] of [[1, 'BROWSER_CONFIRMED_GRCh38', 'project', true], [2, 'BROWSER_PRIVATE_OTHER_SESSION', 'session', true], [3, 'BROWSER_PENDING_GUESS', 'project', false]]) {
        const node = await post('memory-propose', { entry: { title: `Memory fixture ${index}`, text, kind: 'fact', scope, sessionId: scope === 'session' ? 'unrelated-session' : undefined, sources: [{ kind: 'user', ref: 'browser-fixture' }], operationId: `browser-proposal-${index}` } })
        if (confirmed) await post('memory-transition', { change: { id: node.id, revision: node.revision, action: 'confirm', operationId: `browser-confirm-${index}` }, confirmed: true })
      }
    });
    await page.getByLabel('科研问题', { exact: true }).fill('Test-only OmicOS scientific approval request');
    const sendResult = page.waitForResponse(response => response.url().includes('/chat-send') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '发送给科研 Agent', exact: true }).click();
    const sent = await sendResult; assert.equal(sent.status(), 200, await sent.text());
    const binding = await page.evaluate(async () => { const session = await (await fetch('/omicos/oss/api/session')).json(); return (await fetch(`/omicos/oss/api/project/${session.projects[0].id}/chat`)).json() });
    assert(binding.sessionId);
    const main = await context.newPage(); main.on('pageerror', error => errors.push(String(error)));
    await main.goto(origin);
    const notice = main.getByRole('button', { name: /^(Continue|继续)$/ });
    try { await notice.waitFor({ timeout: 8000 }); await notice.click() } catch { /* Notice is shown once per isolated installation. */ }
    const ungrouped = main.locator('[data-row-key="workspace:"]'); await ungrouped.waitFor();
    if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click();
    await main.locator(`[data-row-key="session:${binding.sessionId}"]`).click();
    const approve = main.getByRole('button', { name: /^(Allow once|允许一次)$/ }); await approve.waitFor({ timeout: 15000 });
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    await approve.click();
    await page.locator('.oss-chat-message').filter({ hasText: 'OmicOS mock Scientist connected.' }).waitFor({ timeout: 25000 });
    assert.equal(await fs.readFile(marker, 'utf8'), '42');
    assert(requests.some(body => JSON.stringify(body.system).includes('bioinformatics research agent')));
    assert(requests.some(body => body.tools?.some(tool => tool.name === 'omicos_notebook_run')));
    const scientistRequests = requests.filter(body => body.tools?.some(tool => tool.name === 'omicos_run_python'));
    assert(scientistRequests.length); for (const request of scientistRequests) { const system = JSON.stringify(request); assert(system.includes('BROWSER_CONFIRMED_GRCh38')); assert(!system.includes('BROWSER_PRIVATE_OTHER_SESSION')); assert(!system.includes('BROWSER_PENDING_GUESS')) }

    assert(requests.some(body => body.messages?.some(message => message.content?.some(block => block.type === 'tool_result' && JSON.stringify(block).includes('42')))));
    await page.reload(); await page.locator('.oss-chat-message').filter({ hasText: 'OmicOS mock Scientist connected.' }).waitFor();
    assert.deepEqual(errors, []);
    const output = path.resolve(process.env.OMICOS_SCREENSHOT_DIR || 'test-results/oss-browser'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'harness-scientist.png'), fullPage: true });
    await main.screenshot({ path: path.join(output, 'harness-main.png'), fullPage: true });
    await main.getByRole('tab', { name: 'OmicOS', exact: true }).click();
    const entry = main.getByRole('link', { name: '打开独立科研工作台 ↗', exact: true }); await entry.waitFor();
    const opened = context.waitForEvent('page'); await entry.click(); const linked = await opened;
    linked.on('pageerror', error => errors.push(String(error)));
    await linked.getByRole('button', { name: '新建 Notebook', exact: true }).waitFor();
    assert(new URL(linked.url()).searchParams.has('project'));
    await main.screenshot({ path: path.join(output, 'harness-entry.png'), fullPage: true });
    assert.deepEqual(errors, []);
    // Render the retained legacy console against its public DTO fixture, without a private Core binary.
    await main.route('**/omicos/oss/api/session', async route => { const upstream = await route.fetch(); const session = await upstream.json(); await route.fulfill({ json: { ...session, backend: 'core' } }) })
    await main.route('**/omicos/account', route => route.fulfill({ json: { logged_in: false, login_pending: false, subscribe_url: 'https://app.omicos.cn', account_url: 'https://app.omicos.cn' } }))
    await main.route('**/omicos/kernel', route => route.fulfill({ json: { kernels: [] } }))
    await main.route('**/omicos/capabilities?*', route => route.fulfill({ json: { query: '', indexed: { skills: 0, agents: 0 }, results: [], categories: [] } }))
    await main.reload()
    const legacyGroup = main.locator('[data-row-key="workspace:"]'); await legacyGroup.waitFor();
    if (await legacyGroup.getAttribute('aria-expanded') === 'false') await legacyGroup.click()
    await main.locator(`[data-row-key="session:${binding.sessionId}"]`).click()
    await main.getByRole('tab', { name: 'OmicOS', exact: true }).click()
    await main.getByText('OmicOS · Core 兼容模式', { exact: true }).waitFor()
    await main.getByText('内核', { exact: true }).waitFor(); await main.getByText('能力检索', { exact: true }).waitFor()
    await main.getByText('尚未连接 Core 内核。', { exact: false }).waitFor()
    await main.screenshot({ path: path.join(output, 'core-compat-entry.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ harness: version, ownerAuth: 'unauthenticated 401; Harness owner cookie 200', approval: 'no side effect before Allow once; real Python writes 42 afterwards', scientist: 'scoped persona and Notebook tools', entry: 'actual OmicOS tab -> project-scoped workbench popup', legacyUi: 'Core console DTO fixture retains account/kernel/catalog panes', conversation: 'formal controller -> local mocked provider -> persistent assistant -> reload', pageErrors: errors }));
  } finally {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(force) }
    await new Promise(resolve => model.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(redact(String(error))); process.exitCode = 1 });
