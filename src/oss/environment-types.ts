export interface LockedPackage { name: string; version: string; sha256: string[] }
export interface EnvironmentInstallRequest { operationId: string; title: string; packages: LockedPackage[]; wheelDirectory?: string }
export interface ManagedPythonEnvironment {
  id: string; operationId: string; title: string; requestSha256: string; packages: LockedPackage[]; wheelDirectory?: string
  state: 'preparing' | 'installing' | 'verifying' | 'ready' | 'failed' | 'canceled' | 'interrupted' | 'removed'; createdAt: string; updatedAt: string
  interpreter: string; logTail: string; error?: string; manifestSha256?: string; installed?: Record<string, string>; pythonVersion?: string
}
export interface EnvironmentSelection { revision: number; environmentId: string | null; at: string; operationId?: string }
export class EnvironmentError extends Error { constructor(readonly status: number, message: string) { super(message) } }
