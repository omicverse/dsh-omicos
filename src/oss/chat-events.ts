import type {IncomingMessage,ServerResponse} from 'node:http'
import type {ScienceChat,ChatSnapshot} from './chat.js'
/** Coalesced full public projections: one pending snapshot under backpressure. */
export async function streamChat(request:IncomingMessage,response:ServerResponse,chat:ScienceChat,workspace:string):Promise<void>{
 if(!chat.follow)throw Error('Harness conversation streaming is unavailable')
 const abort=new AbortController();let nextWrite=0;let ended=false,blocked=false,latest:ChatSnapshot|{messages:[];available:true}|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let heartbeat:ReturnType<typeof setInterval>|undefined
 const close=()=>{if(ended)return;ended=true;abort.abort();clearTimeout(timer);clearInterval(heartbeat);response.off('drain',drain);response.off('close',close);response.off('error',close);request.off('aborted',close);if(response.headersSent&&!response.destroyed)response.end()}
 const pump=()=>{timer=undefined;if(ended||blocked||!latest)return;const delay=nextWrite-Date.now();if(delay>0){timer=setTimeout(pump,delay);return}nextWrite=Date.now()+100;const value=latest;latest=undefined;blocked=!response.write(`event: chat\ndata: ${JSON.stringify(value)}\n\n`)}
 const drain=()=>{blocked=false;pump()}
 response.once('close',close);response.once('error',close);request.once('aborted',close);response.on('drain',drain)
 let iterator:AsyncIterator<ChatSnapshot|{messages:[];available:true}>|undefined
 try{
  iterator=chat.follow(workspace,abort.signal)[Symbol.asyncIterator]()
  // Validate the authoritative session/workspace before opening a successful SSE.
  const first=await iterator.next();if(abort.signal.aborted)return
  response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store',connection:'keep-alive','x-accel-buffering':'no'});response.flushHeaders();if(!first.done){latest=first.value;pump()}
  heartbeat=setInterval(()=>{if(!ended&&!blocked)blocked=!response.write(': heartbeat\n\n')},15000)
  while(!ended){const item=await iterator.next();if(item.done)break;latest=item.value;if(!timer&&!blocked)timer=setTimeout(pump,100)}
  if(!blocked)pump()
 }catch(error){if(!response.headersSent)throw error;/* Disconnect; EventSource reconnects to a fresh authoritative baseline. */}
 finally{close();await iterator?.return?.()}
}
