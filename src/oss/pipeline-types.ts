import type { MethodAssessment } from './method-types.js'
import type { Artifact, Execution, KernelEnvironment } from './types.js'
export interface PipelineReference { id: string; version: string; text: string; sha256: string }
export interface PipelineStep { id: string; title: string; code: string; gate: boolean; outputs: string[]; checkpoint?: { files: string[]; restoreCode: string } }
export interface PipelineDefinition { id: string; executorVersion: 1; title: string; language: 'python' | 'r'; parameters: Record<string, unknown>; references: PipelineReference[]; inputs: string[]; steps: PipelineStep[] }
export interface FileEvidence { path: string; bytes: number; sha256: string }
export interface PipelineAttempt { id: string; step: number; kind: 'step' | 'restore'; operationId: string; executionId?: string; state: string; outputTail?: string; error?: string; artifacts?: Artifact[]; files?: FileEvidence[]; environment?: KernelEnvironment; codeHash?: string; outputHash?: string; methodReviews?: MethodAssessment[] }
export interface PipelineCheckpoint { attemptId: string; step: number; files: FileEvidence[] }
export interface PipelineRun { id: string; definitionId: string; operationId: string; revision: number; createdAt: string; updatedAt: string; state: 'preparing' | 'running' | 'waiting' | 'cancelling' | 'canceled' | 'failed' | 'interrupted' | 'succeeded'; nextStep: number; epoch: number; approved: string[]; inputs?: FileEvidence[]; environment?: KernelEnvironment; kernelGeneration?: string; attempts: PipelineAttempt[]; checkpoints: PipelineCheckpoint[]; recoveries: Array<{ epoch: number; action: string; checkpointAttemptId?: string; sideEffectsReviewed: boolean; allowEnvironmentChange: boolean; at: string; expectedFingerprint?: string; observedFingerprint?: string; expectedEnvironment?: KernelEnvironment; observedEnvironment?: KernelEnvironment }>; cancelRequested?: boolean; reason?: string }
export interface PipelineEvent { seq: number; runId: string; type: string; at: string; data: Record<string, unknown> }
export class PipelineError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export type PipelineExecution = Execution
export interface PipelineListQuery { definitionsBefore?: number; runsBefore?: number; definitionQuery?: string; runQuery?: string; state?: string }
export type PipelineRunSummary = Pick<PipelineRun, 'id' | 'definitionId' | 'operationId' | 'revision' | 'createdAt' | 'updatedAt' | 'state' | 'nextStep' | 'epoch' | 'reason' | 'cancelRequested'> & { attempts: number; checkpoints: number; title: string }
