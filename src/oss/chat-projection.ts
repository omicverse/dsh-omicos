import type {ChatMessage,ChatSnapshot} from './chat.js'
/** Public text only: never serialize reasoning, tool arguments, context or raw frames. */
const MAX_TEXT=100000,MAX_HISTORY=200000
function message(record:any):ChatMessage|undefined{
 const event=record?.event,role=event?.type==='user/message'?'user':event?.type==='assistant/message'?'assistant':undefined;if(!role)return
 const data=role==='user'?event.data:event.data?.message;if(role==='user'&&data?.source?.kind!=='user'||!Array.isArray(data?.content))return
 let text='',truncated=false;for(const part of data.content)if(part?.type==='text'&&typeof part.text==='string'){const value=part.text.slice(-MAX_TEXT);truncated||=value.length!==part.text.length||text.length+value.length+(text?1:0)>MAX_TEXT;text=(text+(text?'\n':'')+value).slice(-MAX_TEXT)}
 if(text)return {seq:event.seq,role,text,...event.data?.interrupted?{interrupted:true}:{},...truncated?{truncated:true}:{}}
}
export function publicChatRecords(records:readonly unknown[]):ChatMessage[]{let messages:ChatMessage[]=[];for(const record of records){const event=(record as any)?.event,op=event?.surfaceOp;if(op&&typeof op==='object'&&op.op==='replace')messages=messages.filter(item=>item.seq<op.startSeq||item.seq>op.endSeq);const value=message(record);if(value)messages.push(value)}return bounded(messages)}
function bounded(messages:ChatMessage[]){let remaining=MAX_HISTORY;return messages.slice(-50).reverse().flatMap(item=>{if(!remaining)return [];const text=item.text.slice(-remaining);remaining-=text.length;return [{...item,text,...text.length!==item.text.length?{truncated:true}:{}}]}).reverse()}
export class ChatProjection{
 private messages:ChatMessage[]=[];private cursor=-1;private busy=false;private hasMore=false;private revision=0;private attempt?:{id:string;startedAfter:number;next:number;blocks:Map<number,string>;types:Map<number,string>;truncated:boolean}
 constructor(private sessionId:string){}
 private chunk(value:any){const attempt=this.attempt;if(!attempt||!value||!Number.isSafeInteger(value.index)||value.index<0||value.index>4096)return;const index=value.index
  if(value.type==='block-start'){attempt.types.set(index,value.blockType==='text'?'text':'other');if(value.blockType==='text')attempt.blocks.set(index,'');return}
  if(value.type==='text-delta'&&typeof value.text==='string'&&(!attempt.types.has(index)||attempt.types.get(index)==='text')){attempt.types.set(index,'text');const before=attempt.blocks.get(index)||'',text=value.text.slice(-MAX_TEXT);attempt.truncated||=text.length!==value.text.length||before.length+text.length>MAX_TEXT;attempt.blocks.set(index,(before+text).slice(-MAX_TEXT))}
  if(value.type==='block-end'&&value.block?.type==='text'&&typeof value.block.text==='string'){attempt.types.set(index,'text');attempt.truncated||=value.block.text.length>MAX_TEXT;attempt.blocks.set(index,value.block.text.slice(-MAX_TEXT))}
  // Keep the complete live projection bounded even with many separate text blocks.
  let left=MAX_TEXT;for(const key of [...attempt.blocks.keys()].sort((a,b)=>b-a)){const text=attempt.blocks.get(key)!;if(text.length>left){attempt.blocks.set(key,left?text.slice(-left):'');if(!left)attempt.blocks.delete(key);attempt.truncated=true}left-=Math.min(text.length,left)}
 }
 accept(frame:any):ChatSnapshot{
  if(frame.type==='snapshot'){
   this.cursor=frame.cursor;this.messages=publicChatRecords(frame.records);this.hasMore=!!frame.hasMore;this.busy=false;for(const record of frame.records){if(record?.event?.type==='turn/start')this.busy=true;if(record?.event?.type==='turn/end')this.busy=false}const boundary=frame.projections?.values?.turnBoundary;if(boundary&&'openTurnStartSeq' in boundary)this.busy=boundary.openTurnStartSeq!==null
   this.revision=frame.assistantStream?.revision||0;this.attempt=undefined;const active=frame.assistantStream?.activeAttempt;if(active){this.attempt={id:active.attemptId,startedAfter:active.startedAfterSeq,next:active.nextIndex,blocks:new Map(),types:new Map(),truncated:false};for(const record of active.stream||[]){if(record?.type==='text-chunks'&&Array.isArray(record.texts)){for(const text of record.texts)this.chunk({type:'text-delta',index:record.index,text})}else if(record?.type==='chunk')this.chunk(record.chunk)}this.busy=true}
  }else if(frame.type==='event'){
   const event=frame.event;if(event.seq<=this.cursor)return this.snapshot();if(event.seq!==this.cursor+1)throw Error('Chat event cursor gap; reconnect for an authoritative baseline');this.cursor=event.seq
   const op=event.surfaceOp;if(op&&typeof op==='object'&&op.op==='replace')this.messages=this.messages.filter(item=>item.seq<op.startSeq||item.seq>op.endSeq);const value=message(frame);if(value)this.messages=bounded([...this.messages,value]);if(event.type==='turn/start')this.busy=true;if(event.type==='turn/end')this.busy=false;if(['assistant/message','assistant/attempt'].includes(event.type)&&this.attempt&&event.seq>this.attempt.startedAfter)this.attempt=undefined
  }else if(frame.type==='assistant-stream'){
   const item=frame.frame;if(item.type==='start'&&item.revision===1){this.revision=0;this.attempt=undefined}if(item.revision!==this.revision+1)throw Error('Chat presentation revision gap; reconnect');this.revision=item.revision
   if(item.type==='start'){this.attempt={id:item.attemptId,startedAfter:item.startedAfterSeq,next:0,blocks:new Map(),types:new Map(),truncated:false};this.busy=true}
   if(item.type==='chunk'){if(!this.attempt||this.attempt.id!==item.attemptId||this.attempt.next!==item.index)throw Error('Chat presentation chunk gap; reconnect');this.attempt.next++;this.chunk(item.chunk)}
   if(item.type==='end'){if(this.attempt&&(this.attempt.id!==item.attemptId||this.attempt.next!==item.index))throw Error('Chat presentation terminal gap; reconnect');this.attempt=undefined}
  }
  return this.snapshot()
 }
 snapshot():ChatSnapshot{const attempt=this.attempt;const joined=attempt?[...attempt.blocks].sort(([a],[b])=>a-b).map(([,text])=>text).join('\n'):'';const text=joined.slice(-MAX_TEXT);return {sessionId:this.sessionId,messages:this.messages.map(item=>({...item})),cursor:this.cursor,busy:this.busy,hasMore:this.hasMore,...attempt&&text?{live:{attemptId:attempt.id,text,truncated:attempt.truncated||joined.length>MAX_TEXT}}:{}}}
}
