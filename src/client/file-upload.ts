import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type DataUpload, type UploadSummary } from '../oss/upload-types.js'
import { api, apiUploadChunk } from './oss-api.js'
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')
export async function sourceManifest(file:Pick<File,'size'|'slice'>,signal:AbortSignal,progress:(done:number,total:number)=>void){
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>UPLOAD_MAX_BYTES)throw new Error('单个导入文件最多 10 GiB')
  if(!globalThis.crypto?.subtle)throw new Error('文件校验需要可信的本地浏览器连接')
  const chunkHashes:string[]=[];progress(0,file.size)
  for(let offset=0;offset<file.size;offset+=UPLOAD_CHUNK_BYTES){signal.throwIfAborted();const bytes=await file.slice(offset,offset+UPLOAD_CHUNK_BYTES).arrayBuffer();signal.throwIfAborted();chunkHashes.push(hex(await crypto.subtle.digest('SHA-256',bytes)));progress(Math.min(offset+UPLOAD_CHUNK_BYTES,file.size),file.size)}
  signal.throwIfAborted();const manifestSha256=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({bytes:file.size,chunkSize:UPLOAD_CHUNK_BYTES,chunkHashes}))))
  return {chunkHashes,manifestSha256}
}
export async function transferUpload(projectId:string,record:DataUpload,file:File,signal:AbortSignal,changed:(record:DataUpload)=>void):Promise<DataUpload>{
  const prefix=`project/${projectId}/upload-`;let latest=await api<DataUpload>(`${prefix}document?id=${encodeURIComponent(record.id)}`,undefined,signal)
  if(latest.state==='completed'){changed(latest);return latest}
  if(latest.state!=='uploading')throw new Error('该导入当前不能继续，请读取记录或取消暂存')
  for(let offset=latest.received;offset<latest.bytes;){signal.throwIfAborted();const bytes=await file.slice(offset,Math.min(offset+UPLOAD_CHUNK_BYTES,latest.bytes)).arrayBuffer();const summary=await apiUploadChunk<UploadSummary>(`${prefix}chunk?id=${encodeURIComponent(record.id)}&offset=${offset}`,bytes,signal);latest={...latest,...summary};changed(latest);if(summary.state==='completed')return latest;if(latest.received<=offset)throw new Error('服务端没有确认新的上传进度，请读取记录后重试');offset=latest.received}
  signal.throwIfAborted();latest=await api<DataUpload>(`${prefix}finalize`,{id:record.id,confirmed:true},signal);changed(latest);return latest
}
