import {PipelineError} from './pipeline-types.js'
import {once} from 'node:events'
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {PipelineStore} from './pipeline-store.js'
import type {PipelineExport} from './pipeline-export.js'
export async function streamPipelineExport(request:IncomingMessage,response:ServerResponse,store:PipelineStore,id:string,revision:number):Promise<void>{
 const own=new AbortController(),abort=()=>own.abort();request.once('aborted',abort);response.once('close',abort);response.once('error',abort);let snapshot:PipelineExport|undefined
 try{
  if(request.aborted||response.destroyed)own.abort();own.signal.throwIfAborted();snapshot=await store.exportRun(id,revision,own.signal);const delivery=AbortSignal.any([own.signal,snapshot.signal]);delivery.throwIfAborted()
  response.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="omicos-pipeline-${id}-r${revision}.json"`,'content-length':String(snapshot.bytes),'cache-control':'no-store','x-content-type-options':'nosniff','x-omicos-export-sha256':snapshot.sha256,'x-omicos-pipeline-revision':String(snapshot.revision)})
  for await(const chunk of snapshot.chunks()){delivery.throwIfAborted();if(!response.write(chunk))await once(response,'drain',{signal:delivery})}response.end()
 }catch(error){if(response.headersSent){response.destroy();return}if(!own.signal.aborted){if(snapshot?.signal.aborted)throw new PipelineError(503,'Pipeline export snapshot closed or expired; refresh before downloading again');throw error}}
 finally{request.removeListener('aborted',abort);response.removeListener('close',abort);response.removeListener('error',abort);snapshot?.dispose();own.abort()}
}
