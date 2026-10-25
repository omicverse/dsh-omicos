export interface McpSecretReference { environment: string; prefix?: string }
export type McpConnectionConfig = {
  transport: 'stdio'; serverName: string; command: string; args: string[]; env: Record<string, McpSecretReference>
  toolCallTimeoutMs: number
} | {
  transport: 'streamable-http'; serverName: string; url: string; headers: Record<string, McpSecretReference>
  toolCallTimeoutMs: number
}
export interface McpConnectionRecord {
  id: string; revision: number; title: string; config: McpConnectionConfig; enabled: boolean
  createdAt: string; updatedAt: string; note: string; digest: string
}
export interface McpConnectionDraft {
  id?: string; revision?: number; operationId: string; title: string; config: McpConnectionConfig; note: string
}
export class McpConnectionError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export interface McpHostStatus {
  available: boolean; credentialEnvironmentNames: string[]
  agents: Array<{sessionId:string;connections:Array<{id:string;revision:number;serverName:string;phase:'starting'|'registered'|'failed'|'stopping';tools:string[];diagnostic?:string}>}>
  scope: string
}
export interface McpHostBridge {
  snapshot(workspace:string):Promise<McpHostStatus>
  reconcile(workspace:string):Promise<void>
  dispose():Promise<void>
}
