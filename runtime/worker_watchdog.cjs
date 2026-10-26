/** Own one scientific process family. fd 4 is a Host-lifetime socket, never a data pipe.
 * The supervisor remains responsive while Python/R execute native code. On POSIX the
 * detached supervisor leads the family process group; Host death closes fd 4 and
 * kills that group, including this supervisor. Trusted code can still deliberately
 * escape the group; this is lifecycle management, not an OS sandbox.
 */
const { spawn } = require('node:child_process')
const { Socket } = require('node:net')
const [interpreter, ...arguments_] = process.argv.slice(2)
let child
function stop() {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL') } catch {}
  }
  try { child?.kill('SIGKILL') } catch {}
  process.exit(72)
}
process.on('SIGINT', () => {}) // Host signals the whole group, including the actual worker.
process.on('SIGTERM', () => {}) // Remain alive until the worker exits or the Host escalates.
const lifetime = new Socket({ fd: 4, readable: true, writable: false })
lifetime.on('end', stop); lifetime.on('error', stop); lifetime.resume()
try {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(interpreter, arguments_, { stdio: ['inherit', 'inherit', 'inherit', 3], detached: false, env: environment })
  child.once('error', error => { console.error(`Scientific interpreter could not start: ${error.message}`); stop() })
  child.once('exit', stop)
} catch (error) { console.error(String(error)); stop() }
