/** Optional Host-owned conversation port. The scientific runtime never owns an LLM. */
export interface ChatMessage { seq: number; role: 'user' | 'assistant'; text: string; interrupted?: boolean }
export interface ChatSnapshot { sessionId: string; messages: ChatMessage[]; hasMore: boolean; cursor: number; busy: boolean }
export interface ScienceChat {
  read(workspace: string, signal: AbortSignal): Promise<ChatSnapshot | { sessionId?: string; messages: []; available: true }>
  send(workspace: string, text: string, requestId: string, signal: AbortSignal): Promise<{ sessionId: string; accepted: true }>
  cancel(workspace: string): Promise<void>
}
