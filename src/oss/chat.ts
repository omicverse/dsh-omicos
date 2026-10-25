/** Optional Host-owned conversation port. The scientific runtime never owns an LLM. */
export interface ChatMessage { seq: number; role: 'user' | 'assistant'; text: string; interrupted?: boolean;truncated?:boolean }
export interface ChatSnapshot { sessionId: string; messages: ChatMessage[]; hasMore: boolean; cursor: number; busy: boolean;live?:{attemptId:string;text:string;truncated:boolean} }
export interface ChatHistory { sessionId:string; throughSeq:number; beforeSeq?:number; nextBefore?:number; hasMore:boolean; messages:ChatMessage[] }
export interface ScienceChat {
  history?(workspace:string,options:{throughSeq?:number;beforeSeq?:number},signal:AbortSignal):Promise<ChatHistory>
  follow?(workspace:string,signal:AbortSignal):AsyncIterable<ChatSnapshot|{messages:[];available:true}>
  dispose?():Promise<void>
  read(workspace: string, signal: AbortSignal): Promise<ChatSnapshot | { sessionId?: string; messages: []; available: true }>
  send(workspace: string, text: string, requestId: string, signal: AbortSignal): Promise<{ sessionId: string; accepted: true }>
  cancel(workspace: string): Promise<void>
}
