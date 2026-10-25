import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {open,readFile,realpath} from 'node:fs/promises'
import {workspacePath} from './files.js'
import type {FigureAssemblies} from './assemblies.js'
import {PublicationError,type PdfPublicationProfile,type PdfFontRecord} from './publication-types.js'
const assertActive=(signal:AbortSignal)=>{if(signal.aborted)throw new PublicationError(409,'PDF export canceled; no completed document is available')}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
export function publicationProfile(input:PdfPublicationProfile):PdfPublicationProfile{
  if(!input||typeof input!=='object'||!Number.isSafeInteger(input.dpi)||input.dpi<72||input.dpi>1200)throw new PublicationError(400,'Choose an integer publication DPI between 72 and 1200')
  if(input.font===undefined)return {dpi:input.dpi}
  const font=input.font
  if(!font||typeof font!=='object'||typeof font.path!=='string'||!font.path||font.path.length>1000||typeof font.sha256!=='string'||!/^[a-f0-9]{64}$/.test(font.sha256)||typeof font.licenseDeclaration!=='string'||!font.licenseDeclaration.trim()||font.licenseDeclaration.length>4000)throw new PublicationError(400,'Project font requires a contained path, expected SHA-256 and explicit embedding-license declaration')
  return {dpi:input.dpi,font:{path:font.path,sha256:font.sha256,licenseDeclaration:font.licenseDeclaration}}
}
/** Static sfnt validation before invoking a font parser. This is not legal validation. */
export function fontEmbeddingPolicy(bytes:Buffer){
  if(bytes.length<12)throw new PublicationError(400,'Font header is incomplete')
  const signature=bytes.length>=12?bytes.toString('ascii',0,4):''
  if(signature!=='OTTO'&&!bytes.subarray(0,4).equals(Buffer.from([0,1,0,0])))throw new PublicationError(400,'Use a static TTF/OTF font, not a collection, webfont or other format')
  const count=bytes.readUInt16BE(4);if(count<1||count>256||12+16*count>bytes.length)throw new PublicationError(400,'Invalid font table directory')
  const tables=new Map<string,{offset:number;length:number}>()
  for(let index=0;index<count;index++){const start=12+index*16;const tag=bytes.toString('ascii',start,start+4),offset=bytes.readUInt32BE(start+8),length=bytes.readUInt32BE(start+12);if(tables.has(tag)||offset<12+16*count||offset+length>bytes.length)throw new PublicationError(400,'Invalid or duplicate font table bounds');tables.set(tag,{offset,length})}
  if(tables.has('fvar')||tables.has('CFF2'))throw new PublicationError(400,'Variable fonts are not supported by this PDF exporter; supply a static face')
  if(!tables.has('cmap')||!tables.has('head')||!tables.has('maxp')||(signature==='OTTO'?!tables.has('CFF '):!tables.has('glyf')||!tables.has('loca')))throw new PublicationError(400,'Static outline/cmap tables do not match the declared font format')
  const os=tables.get('OS/2');if(!os||os.length<10)throw new PublicationError(400,'A font with explicit OS/2 embedding flags is required')
  const flags=bytes.readUInt16BE(os.offset+8)
  if(flags&0x0002||flags&0x0200)throw new PublicationError(400,'This font marks outline embedding restricted or bitmap-only; choose an embeddable font')
  return {embeddingFlags:flags,subset:!(flags&0x0100)&&signature!=='OTTO'} // CFF uses full OpenType embedding; the pinned subset encoder failed independent rendering.
}
async function projectFont(workspace:string,profile:NonNullable<PdfPublicationProfile['font']>,sensitive:readonly string[]){
  let path:string;try{path=await workspacePath(workspace,profile.path,sensitive)}catch{throw new PublicationError(403,'Font must be a contained nonprivate project file')}
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{const info=await handle.stat();if(!info.isFile()||info.size<12||info.size>20000000)throw new PublicationError(413,'Font must be a regular file at most 20 MB');const bytes=Buffer.alloc(info.size+1);let length=0;while(length<bytes.length){const chunk=await handle.read(bytes,length,bytes.length-length,length);if(!chunk.bytesRead)break;length+=chunk.bytesRead}const after=await handle.stat();if(length!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs||await realpath(path)!==path)throw new PublicationError(409,'Font changed while reading');const actual=bytes.subarray(0,length);if(sha(actual)!==profile.sha256)throw new PublicationError(409,'Font bytes do not match the expected SHA-256');return {bytes:actual,record:{kind:'project' as const,path:profile.path,sha256:profile.sha256,bytes:length,licenseDeclaration:profile.licenseDeclaration,...fontEmbeddingPolicy(actual)}}}finally{await handle.close()}
}
async function bundledFont(){
  const base=new URL('../../runtime/fonts/',import.meta.url);const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8')) as {name:string;file:string;sha256:string;licenseFile:string;upstream:string;commit:string}
  if(manifest.file!=='SourceSans3-Bold.ttf'||manifest.licenseFile!=='SourceSans3-LICENSE.md'||manifest.sha256!=='9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a')throw new PublicationError(409,'Bundled PDF font manifest changed; restore the package')
  const bytes=await readFile(new URL(manifest.file,base));if(sha(bytes)!==manifest.sha256)throw new PublicationError(409,'Bundled PDF font bytes changed; restore the package')
  const license=await readFile(new URL(manifest.licenseFile,base),'utf8');if(sha(license)!=='56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328')throw new PublicationError(409,'Bundled font license notice changed; restore the package')
  return {bytes,record:{kind:'bundled' as const,name:manifest.name,bytes:bytes.length,sha256:manifest.sha256,licenseDeclaration:license,upstream:manifest.upstream,commit:manifest.commit,...fontEmbeddingPolicy(bytes)}}
}
export type PublicationSource=Awaited<ReturnType<FigureAssemblies['publicationSource']>>
/** Bounded local rendering only. Worker threads are not a filesystem/OS sandbox. */
export class PdfPublications{
  private pending=new Set<Promise<Buffer>>();private stopping=new AbortController();private disposing?:Promise<void>
  constructor(private options:{timeoutMs?:number;workerPath?:URL}={}){}
  render(workspace:string,source:PublicationSource|(()=>Promise<PublicationSource>),input:PdfPublicationProfile,sensitive:readonly string[],signal?:AbortSignal):Promise<Buffer>{
    if(this.stopping.signal.aborted)return Promise.reject(new PublicationError(409,'PDF publication service is closing'))
    if(this.pending.size>=2)return Promise.reject(new PublicationError(429,'Two PDF exports are already active; wait for completion'))
    const profile=publicationProfile(input);const combined=signal?AbortSignal.any([signal,this.stopping.signal]):this.stopping.signal
    const task=this.perform(workspace,source,profile,sensitive,combined);this.pending.add(task);void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task
  }
  private async perform(workspace:string,sourceInput:PublicationSource|(()=>Promise<PublicationSource>),profile:PdfPublicationProfile,sensitive:readonly string[],signal:AbortSignal):Promise<Buffer>{
    assertActive(signal);const source=typeof sourceInput==='function'?await sourceInput():sourceInput;assertActive(signal);const font=profile.font?await projectFont(workspace,profile.font,sensitive):await bundledFont();assertActive(signal)
    if(font.bytes.length+source.images.reduce((total,image)=>total+image.bytes.length,0)>44000000)throw new PublicationError(413,'Combined PNG/font inputs exceed 44 MB')
    const manifest={...source.metadata,schema:'omicos.assembly.pdf/1',exportProfile:{dpi:profile.dpi,font:font.record},exportProfileScope:'Current owner-selected font/physical size are export choices, not automatically assessed by an earlier assembly review. DPI does not upsample source images; original PNGs and this manifest are attached. PDF image drawing uses supported decoded samples, not unchanged PNG containers.'}
    return this.worker(source,manifest,font.bytes,font.record,signal)
  }
  private worker(source:PublicationSource,manifest:unknown,font:Buffer,fontRecord:PdfFontRecord,signal:AbortSignal):Promise<Buffer>{return new Promise((resolve,reject)=>{
    assertActive(signal);let failure:Error|undefined;let result:Buffer|undefined
    const fontData=Uint8Array.from(font);const images=source.images.map(image=>({id:image.figure.id,revision:image.figure.revision,width:image.width,height:image.height,sha256:image.figure.artifact.sha256,bytes:Uint8Array.from(image.bytes)}))
    const worker=new Worker(this.options.workerPath||new URL('../../runtime/figure_pdf.cjs',import.meta.url),{workerData:{record:source.record,manifest,font:fontData,fontRecord,images},transferList:[fontData.buffer,...images.map(image=>image.bytes.buffer)],env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:4}})
    const abort=()=>{failure=new PublicationError(409,'PDF export canceled; rendering worker is stopping');void worker.terminate()}
    const timer=setTimeout(()=>{failure=new PublicationError(408,'PDF rendering exceeded its deadline');void worker.terminate()},this.options.timeoutMs||45000)
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    worker.on('message',(message:{ok?:boolean;pdf?:Uint8Array;error?:string})=>{if(message.ok&&message.pdf instanceof Uint8Array){if(message.pdf.length>64000000){failure=new PublicationError(413,'PDF output exceeds 64 MB');void worker.terminate()}else result=Buffer.from(message.pdf.buffer,message.pdf.byteOffset,message.pdf.byteLength)}else if(message.ok===false)failure=new PublicationError(400,String(message.error||'PDF rendering failed').slice(0,2000))})
    worker.on('error',error=>{failure??=new PublicationError(500,`PDF renderer failed: ${error.message.slice(0,500)}`)})
    worker.on('exit',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(failure)reject(failure);else if(code!==0||!result)reject(new PublicationError(500,'PDF renderer stopped before producing a complete document'));else resolve(result)})
  })}
  dispose():Promise<void>{if(this.disposing)return this.disposing;this.stopping.abort();return this.disposing=Promise.allSettled([...this.pending]).then(()=>{})}
}
