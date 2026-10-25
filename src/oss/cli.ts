#!/usr/bin/env node
import { createServer } from 'node:http'
import { OssRuntime } from './runtime.js'
import { createOssHandler } from './http.js'

const options = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]!
  if (!['--workspace', '--port', '--python', '--rscript', '--cloud-base', '--state-dir'].includes(name) || !process.argv[index + 1]) throw new Error(`Unknown or missing option: ${name}`)
  options.set(name, process.argv[index + 1]!)
}
const port = Number(options.get('--port') || '18620')
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
const runtime = await OssRuntime.open({ python: options.get('--python'), rscript: options.get('--rscript'), cloudBase: options.get('--cloud-base'), stateDir: options.get('--state-dir') })
await runtime.project(options.get('--workspace') || process.cwd())
const server = createServer(createOssHandler(runtime))
server.requestTimeout = 30_000; server.headersTimeout = 15_000
server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`OmicOS OSS: http://127.0.0.1:${typeof address === 'object' ? address?.port : port}/omicos/oss`)
  console.log('Local Python executes trusted code with your OS permissions. Dependencies are never installed automatically.')
})
let closing = false
const close = async () => {
  if (closing) return; closing = true
  server.close(); server.closeIdleConnections()
  await runtime.dispose()
}
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close())
