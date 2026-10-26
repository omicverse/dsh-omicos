/** Public scientific protocol. No private Core or Harness types cross this boundary. */
export const PROTOCOL_VERSION = 1
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'
export interface Artifact { id: string; path: string; mime: string; sha256: string; bytes: number }
export interface KernelEnvironment { language: 'python' | 'r'; version: string; executable: string; platform?: string; isolated?: boolean; packages: Record<string, string | null>; fingerprint: string }
export interface Execution {
  id: string; operationId: string; sessionId: string; language: 'python' | 'r'; code: string
  state: JobState; createdAt: string; startedAt?: string; endedAt?: string
  output: string; error?: string; artifacts: Artifact[]; expectedKernelGeneration?: string; kernelGeneration?: string; environment?: KernelEnvironment
}
export interface Variable { name: string; type: string; shape?: string; preview: string }
export interface Memory { id: string; text: string; source: string; updatedAt: string }
export interface ScienceSnapshot {
  protocol: number; project: string; eventCursor: number; kernel: { state: 'cold' | 'ready' | 'busy'; generation?: string; environment?: KernelEnvironment }
  executionWindow?: { shown: number; total: number; active: number; hasMore: boolean }
  executions: Execution[]; variables: Variable[]; memories: Memory[]
}
export interface PlanEntry {
  code: string; name: string; prices: Record<string, number>; [key: string]: unknown
}
export interface ExecutionSummary {
  id: string; operationId: string; sessionId: string; language: 'python' | 'r'; state: JobState; createdAt: string; startedAt?: string; endedAt?: string
  codePreview: string; outputTail: string; errorTail?: string; artifactCount: number; environmentFingerprint?: string
}
export class HistoryError extends Error { constructor(readonly status: number, message: string) { super(message) } }
