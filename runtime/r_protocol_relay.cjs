/** R popen supplies a POSIX pipe; keep protocol bytes on the inherited fd 3.
 * Linux cannot reopen a Node socket through /dev/fd/3. This relay does not parse
 * messages or mix user stdout into the protocol. It remains in the watchdog's
 * process group and survives cooperative R interrupts until stdin closes.
 */
const { Socket } = require('node:net')
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
const wire = new Socket({ fd: 3, readable: false, writable: true })
wire.on('error', () => process.exit(74))
process.stdin.pipe(wire)
