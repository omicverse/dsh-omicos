import { workerEnvironment } from './worker-environment.js'
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
  const { stdout } = await execute(python, ['-c', code], { timeout: 15000, maxBuffer: 128000, env: workerEnvironment(process.env) })
  return JSON.parse(stdout) as EnvironmentInfo
}

export interface REnvironmentInfo { language: 'r'; version: string; packages: Record<string, string | null> }
export async function inspectREnvironment(rscript: string): Promise<REnvironmentInfo> {
  const code = `if (!requireNamespace('jsonlite',quietly=TRUE)) stop('Selected R environment requires jsonlite; install it explicitly.')
names <- c('jsonlite','Seurat','SingleCellExperiment','DESeq2','edgeR','ggplot2','BiocManager')
installed <- utils::installed.packages()
packages <- setNames(lapply(names,function(name) if (name %in% rownames(installed)) unname(installed[name,'Version']) else NULL), names)
cat(jsonlite::toJSON(list(language='r',version=R.version.string,packages=packages),auto_unbox=TRUE,null='null'))`
  const { stdout } = await execute(rscript, ['--vanilla', '-e', code], { timeout: 30000, maxBuffer: 128000, env: workerEnvironment(process.env) })
  return JSON.parse(stdout) as REnvironmentInfo
}
