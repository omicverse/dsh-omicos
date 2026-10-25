import type {IncomingMessage,ServerResponse} from 'node:http'
type Handler=(request:IncomingMessage,response:ServerResponse)=>void|Promise<void>
/** One lazy handler/nonce per dependency generation; unloading fences late arrivals. */
export function ownedRoute(factory:()=>Promise<Handler>){
 let closed=false;let pending:Promise<Handler>|undefined
 const unavailable=(response:ServerResponse)=>{response.writeHead(503,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify({error:'OmicOS plugin generation unloaded; refresh before retrying'}))}
 return {
  async handle(request:IncomingMessage,response:ServerResponse){
   if(closed){unavailable(response);return}
   // Cache the promise before awaiting it. Caching only the resolved handler
   // lets concurrent startup requests each create their own CSRF nonce.
   pending??=Promise.resolve().then(()=>{if(closed)throw Error('OmicOS route closed before initialization');return factory()})
   let handler:Handler
   try{handler=await pending}catch(error){if(closed){unavailable(response);return}throw error}
   if(closed){unavailable(response);return}
   await handler(request,response)
  },
  close(){closed=true},
 }
}
