/** Public scientific protocol. No private Core or Harness types cross this boundary. */
export const PROTOCOL_VERSION = 1
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'
export interface Artifact { id: string; path: string; mime: string; sha256: string; bytes: number }
export interface Execution {
  id: string; operationId: string; sessionId: string; language: 'python'; code: string
  state: JobState; createdAt: string; startedAt?: string; endedAt?: string
  output: string; error?: string; artifacts: Artifact[]; kernelGeneration?: string
}
export interface Variable { name: string; type: string; shape?: string; preview: string }
export interface Memory { id: string; text: string; source: string; updatedAt: string }
export interface ScienceSnapshot {
  protocol: number; project: string; kernel: { state: 'cold' | 'ready' | 'busy'; generation?: string }
  executions: Execution[]; variables: Variable[]; memories: Memory[]
}
export interface PlanEntry {
  code: string; name: string; prices: Record<string, number>; [key: string]: unknown
}
