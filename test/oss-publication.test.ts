import {expect,it} from 'vitest'
import {build} from 'esbuild'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib'
import {deflateSync} from 'node:zlib'
import {png16,pngChunk} from './png16-helpers.js'
import {pdfAttachments} from './pdf-helpers.js'
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,access} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PdfPublications,fontEmbeddingPolicy,publicationProfile,type PublicationSource} from '../src/oss/publication.js'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
const bundled=new URL('../runtime/fonts/SourceSans3-Bold.ttf',import.meta.url)

function fixture(label='A'):PublicationSource{const record={id:'assembly',revision:2,title:'Publication',caption:'Scientific source',layout:{width:600,height:400,panels:[{figureId:'source',figureRevision:2,x:10,y:10,width:580,height:380,label}]},sources:[],createdAt:'2026-10-25',updatedAt:'2026-10-25',author:'user:workbench',digest:'fixture-digest',review:{state:'approved'}} as PublicationSource['record'];return {record,images:[{figure:{id:'source',revision:2,artifact:{sha256:hash(png)}} as any,bytes:png,width:1,height:1}],metadata:{schema:'omicos.assembly/1',assembly:record,scope:'Fixture',currentSourceIntegrity:{state:'verified'},exportedAt:new Date().toISOString()} as any}}
async function directory(){const path=await mkdtemp(join(tmpdir(),'oss-pdf-'));await mkdir(join(path,'fonts'));return path}
it('produces a real one-page PDF with embedded font, precise physical geometry and exact original PNG/provenance attachments',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{const pdf=await service.render(workspace,fixture(),{dpi:180},[]);expect(pdf.subarray(0,5).toString()).toBe('%PDF-');const {doc,files}=await pdfAttachments(pdf);expect(doc.getPageCount()).toBe(1);expect(doc.getPage(0).getSize()).toEqual({width:240,height:160});expect(files.get('original-source-r2.png')).toEqual(png);const xobjects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);const image=xobjects.lookup(xobjects.keys()[0],PDFRawStream);expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(Buffer.from([255,255,255]));if(image.dict.has(PDFName.of('SMask')))expect(Buffer.from(decodePDFRawStream(image.dict.lookup(PDFName.of('SMask'),PDFRawStream)).decode())).toEqual(Buffer.from([255]));const manifest=JSON.parse(files.get('omicos-assembly-provenance.json')!.toString());expect(manifest.schema).toBe('omicos.assembly.pdf/1');expect(manifest.exportProfile.font.sha256).toBe(hash(await readFile(bundled)));expect(manifest.pdfDetails.panels[0].labelSizePt).toBeCloseTo(8.8);expect(manifest.pdfDetails.embeddedFont.postscriptName).toContain('SourceSans3');expect(files.get('font-license-declaration.txt')!.toString()).toContain('SIL OPEN FONT LICENSE');const fonts=doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);const first=fonts.lookup(fonts.keys()[0],PDFDict);expect(first.get(PDFName.of('BaseFont'))!.toString()).toMatch(/^\/[A-Z]{6}\+SourceSans3-Bold$/);const desc=first.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict).lookup(PDFName.of('FontDescriptor'),PDFDict);expect(desc.has(PDFName.of('FontFile2'))||desc.has(PDFName.of('FontFile3'))).toBe(true)}finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it('rejects missing glyphs, geometry overflow and corrupt or unsupported-color PNGs instead of silently substituting or transforming',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{await expect(service.render(workspace,fixture('科研'),{dpi:180},[])).rejects.toThrow(/lacks label glyphs/);const overflow=fixture('WWWWWWWWWW');overflow.record.layout.panels[0].width=80;await expect(service.render(workspace,overflow,{dpi:180},[])).rejects.toThrow(/exceeds its panel/)
  const high=fixture();high.images[0].bytes=Buffer.from(png);high.images[0].bytes[24]=16;high.images[0].figure.artifact.sha256=hash(high.images[0].bytes);await expect(service.render(workspace,high,{dpi:180},[])).rejects.toThrow(/CRC/)
  const corrupt=fixture();corrupt.images[0].bytes=Buffer.from(png);corrupt.images[0].bytes[corrupt.images[0].bytes.length-1]^=1;corrupt.images[0].figure.artifact.sha256=hash(corrupt.images[0].bytes);await expect(service.render(workspace,corrupt,{dpi:180},[])).rejects.toThrow(/CRC/);
  const color=fixture();const chunk=Buffer.alloc(13);chunk.writeUInt32BE(1);chunk.write('sRGB',4);color.images[0].bytes=Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]);color.images[0].figure.artifact.sha256=hash(color.images[0].bytes);await expect(service.render(workspace,color,{dpi:180},[])).rejects.toThrow(/color-profile/)
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it('pins custom project font bytes, rejects private/outside paths, checksum changes and forbidden embedding policies',async()=>{
 const workspace=await directory();const service=new PdfPublications();const bytes=await readFile(bundled)
 try{await writeFile(join(workspace,'fonts','custom.ttf'),bytes);const font={path:'fonts/custom.ttf',sha256:hash(bytes),licenseDeclaration:'Owner declares OFL embedding permission'};const result=await pdfAttachments(await service.render(workspace,fixture('α'),{dpi:300,font},[]));expect(JSON.parse(result.files.get('omicos-assembly-provenance.json')!.toString()).exportProfile.font).toMatchObject({kind:'project',sha256:font.sha256,path:font.path})
  await expect(service.render(workspace,fixture(),{dpi:300,font:{...font,sha256:'0'.repeat(64)}},[])).rejects.toThrow(/SHA-256/)
  await expect(service.render(workspace,fixture(),{dpi:300,font:{...font,path:'../private.ttf'}},[])).rejects.toMatchObject({status:403})
  await expect(service.render(workspace,fixture(),{dpi:300,font},[join(workspace,font.path)])).rejects.toMatchObject({status:403})
  await symlink(bundled,join(workspace,'fonts','outside.ttf'));await expect(service.render(workspace,fixture(),{dpi:300,font:{...font,path:'fonts/outside.ttf'}},[])).rejects.toMatchObject({status:403})
  const modified=Buffer.from(bytes);let os=0;for(let index=0;index<modified.readUInt16BE(4);index++){const base=12+index*16;if(modified.toString('ascii',base,base+4)==='OS/2')os=modified.readUInt32BE(base+8)}expect(os).toBeGreaterThan(0);modified.writeUInt16BE(2,os+8);expect(()=>fontEmbeddingPolicy(modified)).toThrow(/restricted/);modified.writeUInt16BE(0x100,os+8);expect(fontEmbeddingPolicy(modified).subset).toBe(false);await writeFile(join(workspace,'fonts','full.ttf'),modified);const full=await pdfAttachments(await service.render(workspace,fixture(),{dpi:180,font:{...font,path:'fonts/full.ttf',sha256:hash(modified)}},[]));expect(JSON.parse(full.files.get('omicos-assembly-provenance.json')!.toString()).pdfDetails.embeddedFont.subset).toBe(false)
  expect(()=>publicationProfile({dpi:0})).toThrow();expect(()=>publicationProfile({dpi:180,font:{...font,licenseDeclaration:''}})).toThrow()
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it.skipIf(!process.env.OMICOS_PDF_TEST_FONT)('embeds a real CJK font and retains Chinese labels without a system font fallback',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{const bytes=await readFile(process.env.OMICOS_PDF_TEST_FONT!);await writeFile(join(workspace,'fonts','cjk.otf'),bytes);const pdf=await service.render(workspace,fixture('科研'),{dpi:180,font:{path:'fonts/cjk.otf',sha256:hash(bytes),licenseDeclaration:'Noto Sans CJK, OFL-1.1; fixture owner allows PDF embedding'}},[]);const {doc,files}=await pdfAttachments(pdf);const info=JSON.parse(files.get('omicos-assembly-provenance.json')!.toString());expect(info.pdfDetails.embeddedFont.postscriptName).toContain('NotoSansCJK');expect(info.pdfDetails.embeddedFont.subset).toBe(false);const fonts=doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);const descriptor=fonts.lookup(fonts.keys()[0],PDFDict).lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict).lookup(PDFName.of('FontDescriptor'),PDFDict);const stream=descriptor.lookup(PDFName.of('FontFile3'),PDFRawStream);expect(stream.dict.get(PDFName.of('Subtype'))!.toString()).toBe('/OpenType');expect(hash(Buffer.from(decodePDFRawStream(stream).decode()))).toBe(hash(bytes));const output=process.env.OMICOS_PDF_QA_DIR;if(output){await mkdir(output,{recursive:true});await writeFile(join(output,'cjk-publication.pdf'),pdf)}}finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},30000)
it('terminates actual CPU-bound workers on abort/shutdown and limits concurrent rendering rather than retaining unknown jobs',async()=>{
 const workspace=await directory();const workerPath=new URL('./fixtures/pdf-busy.cjs',import.meta.url);const service=new PdfPublications({workerPath,timeoutMs:10000});const source=fixture();(source.metadata as any).fixtureMarker=join(workspace,'started');const abort=new AbortController()
 try{const pending=service.render(workspace,source,{dpi:180},[],abort.signal);const observed=pending.catch(error=>error);for(let index=0;index<200;index++){try{await access(join(workspace,'started'));break}catch{await new Promise(resolve=>setTimeout(resolve,10))}}await access(join(workspace,'started'));abort.abort();expect(await observed).toMatchObject({status:409});const second=service.render(workspace,source,{dpi:180},[]).catch(error=>error);const third=service.render(workspace,source,{dpi:180},[]).catch(error=>error);let prepared=false;await expect(service.render(workspace,async()=>{prepared=true;return source},{dpi:180},[])).rejects.toMatchObject({status:429});expect(prepared).toBe(false);await service.dispose();expect(await second).toMatchObject({status:409});expect(await third).toMatchObject({status:409});await expect(service.render(workspace,source,{dpi:180},[])).rejects.toMatchObject({status:409})}finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
 const timed=new PdfPublications({workerPath,timeoutMs:2000});const directory2=await directory();const timedSource=fixture();(timedSource.metadata as any).fixtureMarker=join(directory2,'started');try{await expect(timed.render(directory2,timedSource,{dpi:180},[])).rejects.toMatchObject({status:408});await access(join(directory2,'started'))}finally{await timed.dispose();await rm(directory2,{recursive:true,force:true})}
},20000)

it('does not inherit Host Node preload arguments into the fixed PDF worker',async()=>{
 const workspace=await directory();const bytes=await readFile(bundled)
 try{
  await writeFile(join(workspace,'fonts','source.ttf'),bytes)
  await build({entryPoints:[fileURLToPath(new URL('../src/oss/publication.ts',import.meta.url))],outfile:join(workspace,'publication.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'})
  await writeFile(join(workspace,'host-preload.cjs'),"if(!require('node:worker_threads').isMainThread)throw Error('Host preload entered PDF worker');")
  await writeFile(join(workspace,'source.json'),JSON.stringify(fixture()))
  const workerUrl=new URL('../runtime/figure_pdf.cjs',import.meta.url).href
  const script=`import {PdfPublications} from './publication.mjs';import {readFile} from 'node:fs/promises';const source=JSON.parse(await readFile('source.json','utf8'));for(const image of source.images)image.bytes=Buffer.from(image.bytes.data);const renderer=new PdfPublications({workerPath:new URL(${JSON.stringify(workerUrl)})});try{const pdf=await renderer.render(process.cwd(),source,{dpi:180,font:{path:'fonts/source.ttf',sha256:${JSON.stringify(hash(bytes))},licenseDeclaration:'OFL fixture owner permits embedding'}},[]);console.log(pdf.subarray(0,5).toString())}finally{await renderer.dispose()}`
  await writeFile(join(workspace,'render.mjs'),script)
  const result=await promisify(execFile)(process.execPath,['--require',join(workspace,'host-preload.cjs'),join(workspace,'render.mjs')],{cwd:workspace,timeout:15000})
  expect(result.stdout.trim()).toBe('%PDF-')
 }finally{await rm(workspace,{recursive:true,force:true})}
},20000)

it('retains literal 16-bit grayscale/RGB and alpha samples across all PNG filters and Adam7 passes',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{for(const type of [0,2,4,6])for(const interlaced of [false,true]){
  const colors=type===0||type===4?1:3,channels=colors+([4,6].includes(type)?1:0),width=9,height=9;
  const samples=Buffer.alloc(width*height*channels*2);for(let index=0;index<samples.length/2;index++)samples.writeUInt16BE((index*257+1234)%65536,index*2);
  const bytes=png16(width,height,type,samples,interlaced);const source=fixture();source.images[0]={...source.images[0],bytes,width,height};source.images[0].figure.artifact.sha256=hash(bytes);
  const pdf=await service.render(workspace,source,{dpi:180},[]);const {doc,files}=await pdfAttachments(pdf);const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);const image=objects.lookup(objects.keys()[0],PDFRawStream);expect(image.dict.get(PDFName.of('BitsPerComponent'))!.toString()).toBe('16');expect(image.dict.get(PDFName.of('ColorSpace'))!.toString()).toBe(colors===1?'/DeviceGray':'/DeviceRGB');
  const expectedColor=Buffer.alloc(width*height*colors*2),expectedAlpha=Buffer.alloc(width*height*2);for(let pixel=0;pixel<width*height;pixel++){samples.copy(expectedColor,pixel*colors*2,pixel*channels*2,(pixel*channels+colors)*2);if(channels>colors)samples.copy(expectedAlpha,pixel*2,(pixel*channels+colors)*2,(pixel*channels+channels)*2)}
  expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(expectedColor);if(channels>colors){const alpha=image.dict.lookup(PDFName.of('SMask'),PDFRawStream);expect(alpha.dict.get(PDFName.of('BitsPerComponent'))!.toString()).toBe('16');expect(Buffer.from(decodePDFRawStream(alpha).decode())).toEqual(expectedAlpha)}expect(files.get('original-source-r2.png')).toEqual(bytes);
  if(type===6&&interlaced&&process.env.OMICOS_PDF_QA_DIR)await writeFile(join(process.env.OMICOS_PDF_QA_DIR,'png16-publication.pdf'),pdf)
 }
 // The transparent color key must compare both bytes of every channel.
 const source=fixture();const samples=Buffer.from([0x12,0x34,0x12,0x35]);const bytes=png16(2,1,0,samples,false,Buffer.from([0x12,0x34]));source.images[0]={...source.images[0],bytes,width:2,height:1};source.images[0].figure.artifact.sha256=hash(bytes);const {doc}=await pdfAttachments(await service.render(workspace,source,{dpi:180},[]));const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);const image=objects.lookup(objects.keys()[0],PDFRawStream);expect(Buffer.from(decodePDFRawStream(image.dict.lookup(PDFName.of('SMask'),PDFRawStream)).decode())).toEqual(Buffer.from([0,0,255,255]));
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},30000)

it('bounds 16-bit inflate/sample allocations and rejects malformed filter, stream and chunk ordering',async()=>{
 const workspace=await directory();const service=new PdfPublications();const valid=png16(1,1,0,Buffer.from([0x12,0x34]));const header=valid.subarray(0,33),end=pngChunk('IEND',Buffer.alloc(0));
 async function reject(bytes:Buffer,pattern:RegExp){const source=fixture();source.images[0]={...source.images[0],bytes,width:1,height:1};source.images[0].figure.artifact.sha256=hash(bytes);await expect(service.render(workspace,source,{dpi:180},[])).rejects.toThrow(pattern)}
 try{
  await reject(Buffer.concat([header,pngChunk('IDAT',deflateSync(Buffer.from([5,0x12,0x34]))),end]),/filter/);
  await reject(Buffer.concat([header,pngChunk('IDAT',deflateSync(Buffer.alloc(50000))),end]),/buffer|size|length/i);
  await reject(Buffer.concat([header,pngChunk('IDAT',Buffer.concat([deflateSync(Buffer.from([0,0x12,0x34])),Buffer.from([1])])),end]),/sample size/);
  await reject(Buffer.concat([header,header.subarray(8),valid.subarray(33)]),/IHDR order/);
  await reject(Buffer.concat([header,pngChunk('tRNS',Buffer.from([0])),valid.subarray(33)]),/transparency/);
  const largeHeader=Buffer.from(header.subarray(16,29));largeHeader.writeUInt32BE(4000);largeHeader.writeUInt32BE(4000,4);largeHeader[9]=6;const bytes=Buffer.concat([header.subarray(0,8),pngChunk('IHDR',largeHeader),valid.subarray(33)]);const source=fixture();source.images[0]={...source.images[0],bytes,width:4000,height:4000};source.images[0].figure.artifact.sha256=hash(bytes);await expect(service.render(workspace,source,{dpi:180},[])).rejects.toThrow(/sample budget/);
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
