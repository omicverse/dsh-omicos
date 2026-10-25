import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export interface EnvironmentInfo { python: string; executable: string; platform: string; packages: Record<string, string | null> }
/** Probe metadata only. Never import heavy scientific modules or install packages on reads. */
export async function inspectEnvironment(python: string): Promise<EnvironmentInfo> {
  const code = `import importlib.metadata as m,json,sys,platform
result={}
for name in ['numpy','pandas','anndata','scipy','scanpy','omicverse','matplotlib','seaborn']:
 try: result[name]=m.version(name)
 except m.PackageNotFoundError: result[name]=None
print(json.dumps({'python':sys.version.split()[0],'executable':sys.executable,'platform':platform.platform(),'packages':result}))`
  const { stdout } = await execute(python, ['-c', code], { timeout: 15000, maxBuffer: 128000 })
  return JSON.parse(stdout) as EnvironmentInfo
}
