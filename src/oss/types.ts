/** Public scientific protocol. No private Core or Harness types cross this boundary. */
export const PROTOCOL_VERSION = 1
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'
export interface Artifact { id: string; path: string; mime: string; sha256: string; bytes: number }
export interface KernelEnvironment { language: 'python' | 'r'; version: string; executable: string; platform?: string; packages: Record<string, string | null>; fingerprint: string }
export interface Execution {
  id: string; operationId: string; sessionId: string; language: 'python' | 'r'; code: string
  state: JobState; createdAt: string; startedAt?: string; endedAt?: string
  output: string; error?: string; artifacts: Artifact[]; kernelGeneration?: string; environment?: KernelEnvironment
}
export interface Variable { name: string; type: string; shape?: string; preview: string }
export interface Memory { id: string; text: string; source: string; updatedAt: string }
export interface ScienceSnapshot {
  protocol: number; project: string; eventCursor: number; kernel: { state: 'cold' | 'ready' | 'busy'; generation?: string; environment?: KernelEnvironment }
  executions: Execution[]; variables: Variable[]; memories: Memory[]
}
export interface PlanEntry {
  code: string; name: string; prices: Record<string, number>; [key: string]: unknown
}
