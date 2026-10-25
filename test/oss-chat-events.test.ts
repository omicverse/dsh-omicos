import {expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {streamChat} from '../src/oss/chat-events.js'
import type {ScienceChat} from '../src/oss/chat.js'
class Response extends EventEmitter{headersSent=false;destroyed=false;chunks:string[]=[];ends=0;blocked=true;writeHead(){this.headersSent=true}flushHeaders(){}write(text:string){this.chunks.push(text);return !this.blocked}end(){this.ends++;this.destroyed=true}}
it('coalesces fast updates to one latest snapshot while a slow reader is blocked, then closes only its observer',async()=>{
 const response=new Response(),request=new EventEmitter();let produced=0,closed=0;const cancel=vi.fn();const chat={cancel,async *follow(_workspace:string,signal:AbortSignal){try{for(let i=0;i<=1000;i++){produced=i;yield {sessionId:'fixed',messages:[],busy:true,cursor:i,hasMore:false}}await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))}finally{closed++}}} as unknown as ScienceChat
 const pending=streamChat(request as any,response as any,chat,'project');for(let i=0;i<100&&produced<1000;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(produced).toBe(1000);expect(response.chunks).toHaveLength(1);response.blocked=false;response.emit('drain');for(let i=0;i<100&&response.chunks.length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(response.chunks).toHaveLength(2);expect(response.chunks[1]).toContain('"cursor":1000');response.emit('close');await pending;expect(closed).toBe(1);expect(cancel).not.toHaveBeenCalled();expect(request.listenerCount('aborted')).toBe(0)
})
it('does not send successful SSE headers or end the outer response when session validation fails before opening',async()=>{
 const response=new Response(),request=new EventEmitter();const chat={async *follow(){throw Error('different workspace')}} as unknown as ScienceChat;await expect(streamChat(request as any,response as any,chat,'project')).rejects.toThrow(/different workspace/);expect(response.headersSent).toBe(false);expect(response.ends).toBe(0);expect(request.listenerCount('aborted')).toBe(0)
})
