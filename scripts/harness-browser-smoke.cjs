/** Full published Harness profile, synthetic local model only; never reads real model keys. */
const assert = require('node:assert/strict');
const {createHash}=require('node:crypto');
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
  let child, browser, issuedTool = false, issuedMcp = false; const requests = []; const errors = [];
  const model = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text || '{}'); requests.push(body);
      const scientific = body.tools?.some(tool => tool.name === 'omicos_run_python');
      const tool = scientific && !issuedTool; if (tool) issuedTool = true;
      const mcpTool = !tool && scientific && !issuedMcp && body.tools?.some(tool => tool.name === 'mcp__research__echo'); if (mcpTool) issuedMcp = true;
      const events = [
        { type: 'message_start', message: { id: `mock_${requests.length}`, model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_scientific', name: 'omicos_run_python', input: { code: 'from pathlib import Path\nPath("approved-by-ui.txt").write_text("42")\nprint(42)', operation_id: 'harness-browser-scientific' } } : mcpTool ? { type: 'tool_use', id: 'call_mcp', name: 'mcp__research__echo', input: { text: 'Browser MCP approved' } } : { type: 'text', text: '' } },
        ...(tool || mcpTool) ? [] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OmicOS mock Scientist ' } },{ type: 'content_block_delta', index:0,delta:{type:'text_delta',text:'connected.'}}],
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: (tool || mcpTool) ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for(const event of events){response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);if(scientific&&!tool&&!mcpTool&&event.type==='content_block_delta'&&event.delta.text==='OmicOS mock Scientist ')await new Promise(resolve=>setTimeout(resolve,3000))}response.end();
    } catch { response.writeHead(500); response.end() }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    console.log('Preparing an isolated published Harness Web profile…');
    await run(['plugin', '--profile', 'web', 'add', root], env, directory);
    const config = [
      '- id: omicos', '  config:', '    backend: oss', `    workspace: ${JSON.stringify(workspace)}`,
      `    stateDir: ${JSON.stringify(path.join(directory, 'state'))}`, `    python: ${JSON.stringify(process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3')}`,
      `    rscript: ${JSON.stringify(process.env.OMICOS_SCIENCE_TEST_RSCRIPT || 'Rscript')}`,
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
    const mcp = page.locator('article').filter({ has: page.getByText('科研 MCP 扩展连接', { exact: true }) });
    await mcp.getByText('科研 MCP 扩展连接', { exact: true }).click();
    await mcp.getByLabel('MCP 连接名称', { exact: true }).fill('Browser research fixture');
    await mcp.getByLabel('MCP 连接配置 JSON', { exact: true }).fill(JSON.stringify({ transport:'stdio', serverName:'research', command:process.execPath, args:[path.join(root,'test','fixtures','mcp-server.mjs'),path.join(workspace,'mcp-events.jsonl')], env:{}, toolCallTimeoutMs:5000 }));
    await mcp.getByLabel('MCP 决策说明', { exact: true }).fill('Only the local synthetic fixture is authorized.'); await mcp.getByLabel('确认 MCP 访问范围', { exact: true }).check();
    await mcp.getByRole('button', { name:'保存 MCP 配置并停用', exact:true }).click(); await mcp.locator('[data-mcp-enabled]').filter({ hasText:/^disabled$/ }).waitFor();
    const mcpId = (await mcp.locator('[data-mcp-id]').textContent()).trim();
    await mcp.getByLabel('MCP 决策说明', { exact: true }).fill('Enable this project Scientist fixture; each call needs UI approval.'); await mcp.getByLabel('确认 MCP 访问范围', { exact: true }).check();
    await mcp.getByRole('button', { name:'启用此 MCP 连接', exact:true }).click(); await mcp.locator('[data-mcp-enabled]').filter({ hasText:/^enabled$/ }).waitFor();
    await assert.rejects(fs.access(path.join(workspace,'mcp-events.jsonl')), { code:'ENOENT' });
    await mcp.getByText('科研 MCP 扩展连接', { exact: true }).click();
    const importer = page.getByLabel('导入项目数据', { exact: true }); await importer.getByText('导入文件与断点续传', { exact: true }).click();
    const importBytes = Buffer.from('sample,value\nharness,42\n'); const importSha = createHash('sha256').update(importBytes).digest('hex');
    await importer.getByLabel('本机导入文件', { exact: true }).setInputFiles({ name: 'harness-import.csv', mimeType: 'text/csv', buffer: importBytes });
    await importer.getByLabel('导入预期完整 SHA-256', { exact: true }).fill(importSha); await importer.getByRole('button', { name: '批准导入新文件', exact: true }).click();
    await importer.locator('[data-upload-state]').filter({ hasText: 'completed' }).waitFor(); assert.equal(createHash('sha256').update(await fs.readFile(path.join(workspace, 'harness-import.csv'))).digest('hex'), importSha);
    const importSnapshot = await page.evaluate(async () => { const session = await (await fetch('/omicos/oss/api/session')).json(); return (await fetch(`/omicos/oss/api/project/${session.projects[0].id}/snapshot`)).json() }); assert.equal(importSnapshot.executions.length, 0);
    await importer.getByText('导入文件与断点续传', { exact: true }).click();
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
    await page.waitForFunction(async () => { const session=await (await fetch('/omicos/oss/api/session')).json(); const state=await (await fetch(`/omicos/oss/api/project/${session.projects[0].id}/mcp-state`)).json(); return state.host.agents.some(agent=>agent.connections.some(connection=>connection.phase==='registered'&&connection.tools.includes('mcp__research__echo'))) });
    await approve.click();
    await approve.waitFor({ timeout:15000 });
    assert(!(await fs.readFile(path.join(workspace,'mcp-events.jsonl'),'utf8')).includes('invoked'));
    await approve.click();
    await page.locator('[data-chat-live]').filter({hasText:'OmicOS mock Scientist'}).waitFor({timeout:25000});await page.locator('[data-chat-connection]').filter({hasText:'实时连接'}).waitFor();await page.reload();await page.locator('[data-chat-live]').filter({hasText:'OmicOS mock Scientist'}).waitFor({timeout:15000});
    await page.locator('.oss-chat-message:not([data-chat-live])').filter({ hasText: 'OmicOS mock Scientist connected.' }).waitFor({ timeout: 25000 });
    await page.locator('[data-chat-live]').waitFor({state:'detached'});assert.equal(requests.filter(body=>body.tools?.some(tool=>tool.name==='omicos_run_python')).length,3,'Observer reconnect must not repeat model requests');
    await page.getByRole('button',{name:'浏览固定会话历史',exact:true}).click();await page.getByText('已到历史起点',{exact:false}).waitFor();assert.equal(await page.locator('.oss-chat-message').filter({hasText:'OmicOS mock Scientist connected.'}).count(),2);assert.equal(requests.filter(body=>body.tools?.some(tool=>tool.name==='omicos_run_python')).length,3,'Reading history must not invoke the model');
    assert.equal(await fs.readFile(marker, 'utf8'), '42');
    assert(issuedMcp); assert((await fs.readFile(path.join(workspace,'mcp-events.jsonl'),'utf8')).includes('Browser MCP approved'));
    assert(requests.some(body=>body.messages?.some(message=>message.content?.some(block=>block.type==='tool_result'&&JSON.stringify(block).includes('Browser MCP approved; credential=false')))));
    await mcp.getByText('科研 MCP 扩展连接', { exact:true }).click(); await mcp.getByRole('button', { name:'Browser research fixture', exact:true }).click();
    await mcp.getByLabel('MCP 决策说明', { exact:true }).fill('Stop the real scoped fixture'); await mcp.getByLabel('确认 MCP 访问范围', { exact:true }).check(); await mcp.getByRole('button', { name:'停用此 MCP 连接', exact:true }).click(); await mcp.locator('[data-mcp-enabled]').filter({hasText:/^disabled$/}).waitFor();
    await page.waitForFunction(async () => { const session=await (await fetch('/omicos/oss/api/session')).json(); const state=await (await fetch(`/omicos/oss/api/project/${session.projects[0].id}/mcp-state`)).json(); return state.host.agents.every(agent=>agent.connections.length===0) });
    await mcp.getByRole('button', { name:'读取 MCP 修订历史', exact:true }).click(); await mcp.getByRole('button', { name:'查看 MCP r2', exact:true }).click(); await mcp.getByText('历史 MCP 配置 r2（只读）', { exact:true }).waitFor();
    await mcp.getByText('科研 MCP 扩展连接', { exact:true }).click();
    assert(requests.some(body => JSON.stringify(body.system).includes('bioinformatics research agent')));
    assert(requests.some(body => body.tools?.some(tool => tool.name === 'omicos_notebook_run')));
    const scientistRequests = requests.filter(body => body.tools?.some(tool => tool.name === 'omicos_run_python'));
    assert(scientistRequests.length); for (const request of scientistRequests) { const system = JSON.stringify(request); assert(system.includes('BROWSER_CONFIRMED_GRCh38')); assert(!system.includes('BROWSER_PRIVATE_OTHER_SESSION')); assert(!system.includes('BROWSER_PENDING_GUESS')) }

    assert(requests.some(body => body.messages?.some(message => message.content?.some(block => block.type === 'tool_result' && JSON.stringify(block).includes('42')))));
    await page.reload(); await page.locator('.oss-chat-message:not([data-chat-live])').filter({ hasText: 'OmicOS mock Scientist connected.' }).waitFor();
    assert.deepEqual(errors, []);
    const output = path.resolve(process.env.OMICOS_SCREENSHOT_DIR || 'test-results/oss-browser'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'harness-scientist.png'), fullPage: true });
    await main.screenshot({ path: path.join(output, 'harness-main.png'), fullPage: true });
    await main.getByRole('tab', { name: 'OmicOS', exact: true }).click();
    const entry = main.locator('.omicos-conversation-tools'); await entry.waitFor();
    assert.equal(await entry.locator('a[target="_blank"][href^="/omicos/oss"]').count(), 0, 'Scientific tools must stay inside the real application');
    await entry.getByRole('navigation', { name: '会话科研工具' }).getByRole('button', { name: 'Notebook', exact: true }).click();
    await entry.getByRole('button', { name: '新建 Notebook', exact: true }).click();
    await entry.getByLabel('Notebook 标题', { exact: true }).fill('Native Harness UI verification');
    await entry.getByLabel('Notebook 单元 1 内容', { exact: true }).fill('print(6 * 7)');
    await entry.getByRole('button', { name: '保存并批准运行单元 1', exact: true }).click();
    await entry.locator('.oss-notebook .oss-output').filter({ hasText: '42' }).waitFor();
    await entry.getByLabel('Notebook 单元 1 内容', { exact: true }).fill('# unsaved native navigation draft\nprint(43)');
    const rail = main.getByRole('navigation', { name: 'OmicOS 功能导航', exact: true });
    await rail.getByRole('button', { name: '数据盘', exact: true }).click();
    await main.locator('[data-omicos-page="data"]').waitFor();
    await rail.getByRole('button', { name: 'Notebook', exact: true }).click();
    const nativeNotebook = main.locator('[data-omicos-page="notebook"]');
    await nativeNotebook.getByRole('button', { name: '恢复草稿', exact: true }).click();
    assert.equal(await nativeNotebook.getByLabel('Notebook 单元 1 内容', { exact: true }).inputValue(), '# unsaved native navigation draft\nprint(43)');
    const saved = main.waitForResponse(response => response.url().includes('/notebook-save') && response.request().method() === 'POST');
    await nativeNotebook.getByRole('button', { name: '保存 Notebook', exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal(await nativeNotebook.locator('.oss-notebook .oss-output').count(), 0, 'Editing invalidates prior outputs and never runs the draft');
    if (process.env.OMICOS_SCIENCE_TEST_RSCRIPT) {
      await nativeNotebook.getByLabel('分析语言', { exact: true }).selectOption('r');
      await nativeNotebook.getByRole('button', { name: '新建 Notebook', exact: true }).click();
      await nativeNotebook.getByLabel('Notebook 单元 1 内容', { exact: true }).fill('mean(c(2, 4, 6))');
      await nativeNotebook.getByRole('button', { name: '保存并批准运行单元 1', exact: true }).click();
      await nativeNotebook.locator('.oss-notebook .oss-output').filter({ hasText: '[1] 4' }).waitFor();
    }
    await rail.getByRole('button', { name: '对话', exact: true }).click();
    const expandRight = main.locator('[data-sidebar-right-expand]');
    if (await expandRight.isVisible()) await expandRight.click();
    const right = main.locator('[data-rightbar-col]');
    await right.locator('[data-sidebar-right-guide-entry="omicos-memory"]').click();
    await right.locator('[data-omicos-page="memory"]').waitFor();
    await right.getByText('BROWSER_CONFIRMED_GRCh38', { exact: false }).first().waitFor();
    await main.screenshot({ path: path.join(output, 'harness-scientific-sidebar.png'), fullPage: true });
    await right.getByRole('button', { name: /^(Collapse right sidebar|收起右侧边栏)$/ }).click();
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
    console.log(JSON.stringify({ harness: version, ownerAuth: 'unauthenticated 401; Harness owner cookie 200', approval: 'no side effect before Allow once; real Python writes 42 afterwards', dataImport: 'actual Harness owner cookie/CSRF binary PUT, verified file hash and no automatic execution', mcp: 'real Scientist-scoped stdio plugin, UI enable/disable, actual separate call approval and immutable history', scientist: 'scoped persona and Notebook tools', entry: 'native OmicOS conversation tools and main panels; real Notebook Python 42; unsaved draft restored after navigation without execution', legacyUi: 'Core console DTO fixture retains account/kernel/catalog panes', conversation: 'formal controller follow -> visible partial text -> reload/reconnect partial baseline without another model call -> one committed assistant message -> reload; no second model loop', pageErrors: errors }));
  } finally {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(force) }
    await new Promise(resolve => model.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(redact(String(error))); process.exitCode = 1 });
