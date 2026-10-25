/** Own an installer family and report the actual command result on fd 3.
 * fd 4 is exclusively a Host-lifetime socket; installed packages never inherit it.
 */
const { spawn } = require('node:child_process')
const { Socket } = require('node:net')
const { writeSync } = require('node:fs')
let child
function stop() {
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL') } catch {} }
  try { child?.kill('SIGKILL') } catch {}
  process.exit(72)
}
process.on('SIGINT', () => {}); process.on('SIGTERM', () => {})
const lifetime = new Socket({ fd: 4, readable: true, writable: false })
lifetime.on('end', stop); lifetime.on('error', stop); lifetime.resume()
try {
  const [command, ...args] = process.argv.slice(2); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env })
  child.once('error', error => { try { writeSync(3, JSON.stringify({ error: error.message })+'\n') } catch {}; stop() })
  child.once('close', (code, signal) => { try { writeSync(3, JSON.stringify({ code, signal })+'\n') } catch {}; stop() })
} catch (error) { try { writeSync(3, JSON.stringify({ error: String(error) })+'\n') } catch {}; stop() }
