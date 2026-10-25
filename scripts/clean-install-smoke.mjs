/** Test the actual packed standalone product without Harness or private Core installed. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'omicos-clean-install-'))
let child
try {
  const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, maxBuffer: 2 * 1024 * 1024 })
  const info = JSON.parse(packed.stdout)[0]
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'omicos-oss-clean-smoke', version: '1.0.0', private: true }))
  await execute('npm', ['install', '--ignore-scripts', '--omit=dev', '--omit=optional', '--legacy-peer-deps', join(directory, info.filename)], { cwd: directory, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  const installation = join(directory, 'node_modules', '@omicverse', 'dsh-omicos')
  await access(join(installation, 'runtime', 'python_worker.py'))
  await access(join(installation, 'lib', 'workbench.css'))
  await access(join(installation, 'lib', 'third-party-standalone.txt'))
  await access(join(installation, 'lib', 'third-party-workbench.txt'))
  const font=await readFile(join(installation,'runtime','fonts','SourceSans3-Bold.ttf'));assert.equal(createHash('sha256').update(font).digest('hex'),'9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a');const license=await readFile(join(installation,'runtime','fonts','SourceSans3-LICENSE.md'),'utf8');assert(license.includes('SIL OPEN FONT LICENSE'))
  const plain=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');const srgbChunk=Buffer.from('000000017352474200aece1ce9','hex');const original=Buffer.concat([plain.subarray(0,33),srgbChunk,plain.subarray(33)]);const digest=createHash('sha256').update(original).digest('hex')
  const publication=await new Promise((resolve,reject)=>{let result;const worker=new Worker(join(installation,'runtime','figure_pdf.cjs'),{env:{},workerData:{record:{title:'Packed PDF',caption:'No Core or Harness needed',layout:{width:600,height:400,panels:[{figureId:'source',figureRevision:1,x:10,y:10,width:580,height:380,label:'A'}]}},manifest:{schema:'omicos.assembly.pdf/1',exportedAt:new Date().toISOString(),exportProfile:{dpi:180}},font,fontRecord:{kind:'bundled',sha256:createHash('sha256').update(font).digest('hex'),subset:true,licenseDeclaration:license},images:[{id:'source',revision:1,width:1,height:1,sha256:digest,bytes:original}]}});const timer=setTimeout(()=>{void worker.terminate();reject(Error('Packed PDF worker timed out'))},15000);worker.on('message',message=>{if(!message.ok)reject(Error(message.error));else result=Buffer.from(message.pdf)});worker.once('error',reject);worker.once('exit',code=>{clearTimeout(timer);if(code!==0||!result)reject(Error('Packed PDF worker did not finish'));else resolve(result)})});assert.equal(publication.subarray(0,5).toString(),'%PDF-')
  const manifest = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'))
  const version = await execute(process.execPath, [join(installation, 'lib', 'oss', 'cli.js'), '--version'], { cwd: directory })
  assert.equal(version.stdout.trim(), manifest.version)
  assert(!manifest.dependencies?.['@omicverse/omicos'] && !manifest.optionalDependencies?.['@omicverse/omicos'])
  await assert.rejects(access(join(directory, 'node_modules', '@omicverse', 'omicos')))
  child = spawn(process.execPath, [join(installation, 'lib', 'oss', 'cli.js'), '--workspace', join(directory, 'research'), '--state-dir', join(directory, 'state'), '--cloud-base', 'http://127.0.0.1:9', '--port', '0'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  const launch = await new Promise((resolve, reject) => {
    let output = ''; let errors = ''
    const timer = setTimeout(() => reject(new Error(`Packed CLI startup timed out: ${errors}`)), 15000)
    child.stdout.on('data', chunk => { output += chunk; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/); if (found) { clearTimeout(timer); resolve(found[0]) } })
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000) })
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packed CLI exited ${code}: ${errors}`)) })
  })
  const base = new URL(launch).origin
  const token = new URL(launch).searchParams.get('omicos_token')
  assert(token)
  assert.equal((await fetch(`${base}/omicos/oss/api/session`)).status, 401)
  const fetchHost = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
  const session = await (await fetchHost(`${base}/omicos/oss/api/session`)).json()
  const capabilities = await (await fetchHost(`${base}/omicos/oss/api/capabilities`)).json()
  assert.equal(capabilities.runtimeVersion, manifest.version)
  assert.equal(capabilities.protocol.current, 1)
  assert.equal(session.projects.length, 1)
  const project = session.projects[0].id
  const response = await fetchHost(`${base}/omicos/oss/api/project/${project}/execute`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omicos-csrf': session.csrf }, body: JSON.stringify({ code: 'answer = 40 + 2\nprint(answer)', operationId: 'packed-smoke', confirmed: true }) })
  assert.equal(response.status, 200)
  const accepted = await response.json()
  let result
  for (let count = 0; count < 150; count++) {
    const snapshot = await (await fetchHost(`${base}/omicos/oss/api/project/${project}/snapshot`)).json()
    result = snapshot.executions.find(execution => execution.id === accepted.id)
    if (result && !['queued', 'running'].includes(result.state)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(result?.state, 'succeeded'); assert.match(result.output, /42/)
  assert.equal((await fetchHost(`${base}/omicos/oss/workbench.js`)).status, 200)
  console.log(JSON.stringify({ packed: info.filename, privateCoreRequired: false, harnessRequiredForStandalone: false, pdf: 'embedded-font worker, independent PNG decoder and bundled sRGB ICC usable in clean install', execution: result.state, output: result.output.trim() }))
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited; clearTimeout(force)
  }
  await rm(directory, { recursive: true, force: true })
}
