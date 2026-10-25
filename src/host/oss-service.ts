import type { OssRuntime } from '../oss/runtime.js'
export interface OmicosScienceHost { runtime: Promise<OssRuntime>; workspace: string }
declare module '@deepseek-ai/cordis' { interface Context { omicosScience: OmicosScienceHost } }
