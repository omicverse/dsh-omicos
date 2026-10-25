import type { Artifact, KernelEnvironment } from './types.js'
export interface FigureSource { kind: 'project' | 'pipeline'; language: 'python' | 'r'; executionId: string; artifactId: string; runId?: string }
export interface FigureDraft { id?: string; revision?: number; title: string; caption: string; source: FigureSource; methods: string[]; dataReferences: string[]; operationId: string }
export interface FigureVersion { id: string; revision: number; title: string; caption: string; source: FigureSource; methods: string[]; dataReferences: string[]; artifact: Artifact; createdAt: string; updatedAt: string; author: string; digest: string; execution: { id: string; state: string; code: string; codeSha256: string; outputSha256: string; environment?: KernelEnvironment }; review: { state: 'draft' | 'approved' | 'changes-requested' | 'withdrawn'; actor?: string; note?: string; at?: string; assessedDigest?: string } }
export interface ResolvedFigure { artifact: Artifact; execution: import('./types.js').Execution; bytes: Buffer }
export class FigureError extends Error { constructor(readonly status: number, message: string) { super(message) } }
