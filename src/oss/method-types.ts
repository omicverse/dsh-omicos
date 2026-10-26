export interface ScientificMethod {
  key: string; version: string; title: string; description: string; body: string
  authors: string[]; sources: string[]; license: { id: string; text: string }
}
export interface MethodPack { schema: 'omicos.methods/1'; methods: ScientificMethod[] }
export interface MethodReview { id: string; revision: number; state: 'draft' | 'published' | 'withdrawn'; actor: string; note: string; at: string }
export interface MethodRecord { id: string; document: ScientificMethod; createdAt: string; proposedBy: string; review: MethodReview }
export interface MethodAssessment { id: string; version: string; sha256: string; reviewRevision: number; reviewedAt: string }
export class MethodError extends Error { constructor(readonly status: number, message: string) { super(message) } }
