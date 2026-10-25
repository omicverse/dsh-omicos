import type { KernelEnvironment } from './types.js'
export interface ResearchStep { id: string; title: string; inputs: string[]; outputs: string[]; methods: string[]; risk: string; acceptance: string }
export interface ResearchDefinition { title: string; objective: string; steps: ResearchStep[] }
export interface PlanEvidenceSource { kind: 'project' | 'pipeline'; executionId: string; runId?: string }
export interface PlanEvidence extends PlanEvidenceSource { language: 'python' | 'r'; state: string; codeSha256: string; outputSha256: string; environment?: KernelEnvironment; artifacts: Array<{ id: string; sha256: string; bytes: number }>; recordedAt: string }
export interface PlanTaskAssessment { stepId: string; state: 'completed' | 'blocked' | 'skipped'; note: string; actor: string; at: string; evidence: PlanEvidence[] }
export interface ResearchPlan {
  id: string; revision: number; definition: ResearchDefinition; definitionSha256: string
  status: 'draft' | 'approved' | 'rejected' | 'withdrawn'; approval?: { actor: string; at: string; note: string; definitionSha256: string }
  assessments: PlanTaskAssessment[]; actor: string; note: string; action: string; decisionStepId?: string; createdAt: string; updatedAt: string; digest: string
}
export interface ResearchPlanDraft { id?: string; revision?: number; definition: ResearchDefinition; operationId: string }
export interface PlanDecision { id: string; revision: number; operationId: string; action: 'approve' | 'reject' | 'withdraw' | 'complete' | 'block' | 'skip' | 'reopen'; note: string; stepId?: string; evidence?: PlanEvidenceSource[] }
export class ResearchPlanError extends Error { constructor(readonly status: number, message: string) { super(message) } }
