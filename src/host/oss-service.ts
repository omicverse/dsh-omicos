import type { OssRuntime } from '../oss/runtime.js'
import type {HarnessProjectMcp} from './oss-mcp.js'
export interface OmicosScienceHost { runtime: Promise<OssRuntime>; workspace: string; mcp?:HarnessProjectMcp }
declare module '@deepseek-ai/cordis' { interface Context { omicosScience: OmicosScienceHost } }
