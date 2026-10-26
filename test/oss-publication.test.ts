import {expect,it} from 'vitest'
import {build} from 'esbuild'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib'
import {deflateSync} from 'node:zlib'
import {png16,pngSamples,pngChunk} from './png16-helpers.js'
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
 try{const pdf=await service.render(workspace,fixture(),{dpi:180},[]);expect(pdf.subarray(0,5).toString()).toBe('%PDF-');const {doc,files}=await pdfAttachments(pdf);expect(doc.getPageCount()).toBe(1);expect(doc.getPage(0).getSize()).toEqual({width:240,height:160});expect(files.get('original-source-r2.png')).toEqual(png);const xobjects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);const image=xobjects.lookup(xobjects.keys()[0],PDFRawStream);expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(Buffer.from([255]));if(image.dict.has(PDFName.of('SMask')))expect(Buffer.from(decodePDFRawStream(image.dict.lookup(PDFName.of('SMask'),PDFRawStream)).decode())).toEqual(Buffer.from([255]));const manifest=JSON.parse(files.get('omicos-assembly-provenance.json')!.toString());expect(manifest.schema).toBe('omicos.assembly.pdf/1');expect(manifest.exportProfile.font.sha256).toBe(hash(await readFile(bundled)));expect(manifest.pdfDetails.panels[0].labelSizePt).toBeCloseTo(8.8);expect(manifest.pdfDetails.embeddedFont.postscriptName).toContain('SourceSans3');expect(files.get('font-license-declaration.txt')!.toString()).toContain('SIL OPEN FONT LICENSE');const fonts=doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);const first=fonts.lookup(fonts.keys()[0],PDFDict);expect(first.get(PDFName.of('BaseFont'))!.toString()).toMatch(/^\/[A-Z]{6}\+SourceSans3-Bold$/);const desc=first.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict).lookup(PDFName.of('FontDescriptor'),PDFDict);expect(desc.has(PDFName.of('FontFile2'))||desc.has(PDFName.of('FontFile3'))).toBe(true)}finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it('rejects missing glyphs, geometry overflow and corrupt or unsupported-color PNGs instead of silently substituting or transforming',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{await expect(service.render(workspace,fixture('科研'),{dpi:180},[])).rejects.toThrow(/lacks label glyphs/);const overflow=fixture('WWWWWWWWWW');overflow.record.layout.panels[0].width=80;await expect(service.render(workspace,overflow,{dpi:180},[])).rejects.toThrow(/exceeds its panel/)
  const high=fixture();high.images[0].bytes=Buffer.from(png);high.images[0].bytes[24]=16;high.images[0].figure.artifact.sha256=hash(high.images[0].bytes);await expect(service.render(workspace,high,{dpi:180},[])).rejects.toThrow(/CRC/)
  const corrupt=fixture();corrupt.images[0].bytes=Buffer.from(png);corrupt.images[0].bytes[corrupt.images[0].bytes.length-1]^=1;corrupt.images[0].figure.artifact.sha256=hash(corrupt.images[0].bytes);await expect(service.render(workspace,corrupt,{dpi:180},[])).rejects.toThrow(/CRC/);
  const color=fixture();const chunk=Buffer.alloc(13);chunk.writeUInt32BE(1);chunk.write('sRGB',4);color.images[0].bytes=Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]);color.images[0].figure.artifact.sha256=hash(color.images[0].bytes);await expect(service.render(workspace,color,{dpi:180},[])).rejects.toThrow(/CRC/)
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

it('preserves exact RGB and grayscale ICC profiles and maps sRGB intent without changing 8/16-bit samples',async()=>{
 const workspace=await directory();const service=new PdfPublications();const rgbProfile=await readFile(new URL('../runtime/color-profiles/srgb-lcms216.icc',import.meta.url)),grayProfile=await readFile(new URL('./fixtures/generated-gray.icc',import.meta.url));
 const iCCP=(profile:Buffer)=>pngChunk('iCCP',Buffer.concat([Buffer.from('Research profile\0\0'),deflateSync(profile)]));
 try{for(const type of [0,2,4,6])for(const standard of [false,true]){
  const colors=[0,4].includes(type)?1:3,channels=colors+([4,6].includes(type)?1:0),samples=Buffer.alloc(channels*2);for(let i=0;i<channels;i++)samples.writeUInt16BE(12345+i*789,i*2);const original=png16(1,1,type,samples),profile=standard||colors===3?rgbProfile:grayProfile;const bytes=Buffer.concat([original.subarray(0,33),standard?pngChunk('sRGB',Buffer.from([2])):iCCP(profile),original.subarray(33)]);const source=fixture();source.images[0]={...source.images[0],bytes,width:1,height:1};source.images[0].figure.artifact.sha256=hash(bytes);const pdf=await service.render(workspace,source,{dpi:180},[]);const {doc,files}=await pdfAttachments(pdf);const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);const image=objects.lookup(objects.keys()[0],PDFRawStream),space=image.dict.lookup(PDFName.of('ColorSpace'),PDFArray);expect(space.get(0).toString()).toBe('/ICCBased');const icc=space.lookup(1,PDFRawStream);expect(Buffer.from(decodePDFRawStream(icc).decode())).toEqual(profile);expect(icc.dict.get(PDFName.of('N'))!.toString()).toBe(standard?'3':String(colors));const expected=standard&&colors===1?Buffer.concat([samples.subarray(0,2),samples.subarray(0,2),samples.subarray(0,2)]):samples.subarray(0,colors*2);expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(expected);if(channels>colors){const alpha=image.dict.lookup(PDFName.of('SMask'),PDFRawStream);expect(alpha.dict.get(PDFName.of('ColorSpace'))!.toString()).toBe('/DeviceGray');expect(Buffer.from(decodePDFRawStream(alpha).decode())).toEqual(samples.subarray(colors*2))}const metadata=JSON.parse(files.get('omicos-assembly-provenance.json')!.toString());expect(metadata.pdfDetails.sourceEncodings[0].color).toMatchObject({kind:standard?'srgb':'embedded-icc',sha256:hash(profile)});expect(files.get('original-source-r2.png')).toEqual(bytes);if(!standard&&process.env.OMICOS_PDF_QA_DIR&&[4,6].includes(type))await writeFile(join(process.env.OMICOS_PDF_QA_DIR,type===4?'gray-icc-publication.pdf':'icc-publication.pdf'),pdf)
 }
 // 8-bit truecolor is decoded without changing channel values.
 const head=Buffer.alloc(13);head.writeUInt32BE(1);head.writeUInt32BE(1,4);head[8]=8;head[9]=2;const bytes=Buffer.concat([png.subarray(0,8),pngChunk('IHDR',head),iCCP(rgbProfile),pngChunk('IDAT',deflateSync(Buffer.from([0,21,43,65]))),pngChunk('IEND',Buffer.alloc(0))]);const source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);const {doc}=await pdfAttachments(await service.render(workspace,source,{dpi:180},[]));const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);expect(Buffer.from(decodePDFRawStream(objects.lookup(objects.keys()[0],PDFRawStream)).decode())).toEqual(Buffer.from([21,43,65]));
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},30000)

it('decodes packed grayscale/palette PNGs and transparency independently without losing represented samples',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{for(const bits of [1,2,4,8])for(const interlaced of [false,true])for(const type of [0,3]){
  const count=2**bits,samples=Buffer.from(Array.from({length:9*9},(_,i)=>i%count)),key=type===0?Buffer.from([0,1]):Buffer.from([0,123]);let bytes=pngSamples(9,9,type,samples,bits,interlaced,key);const palette=Buffer.from(Array.from({length:count*3},(_,i)=>(i*71)%256));if(type===3)bytes=Buffer.concat([bytes.subarray(0,33),pngChunk('PLTE',palette),bytes.subarray(33)]);const source=fixture();source.images[0]={...source.images[0],bytes,width:9,height:9};source.images[0].figure.artifact.sha256=hash(bytes);const {doc}=await pdfAttachments(await service.render(workspace,source,{dpi:180},[]));const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict),image=objects.lookup(objects.keys()[0],PDFRawStream);expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(type===0?Buffer.from([...samples].map(value=>value*255/(count-1))):Buffer.concat([...samples].map(value=>palette.subarray(value*3,value*3+3))));expect(Buffer.from(decodePDFRawStream(image.dict.lookup(PDFName.of('SMask'),PDFRawStream)).decode())).toEqual(Buffer.from([...samples].map(value=>type===0?(value===1?0:255):value===0?0:value===1?123:255)))
 }
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},30000)
it('maps declared gamma/chromaticities to calibrated PDF spaces, leaves alpha linear and records missing-primary assumptions',async()=>{
 const workspace=await directory();const service=new PdfPublications();const gamma=Buffer.alloc(4);gamma.writeUInt32BE(50000);const xy=Buffer.alloc(32);[31270,32900,64000,33000,30000,60000,15000,6000].forEach((value,i)=>xy.writeUInt32BE(value,i*4));
 try{for(const type of [0,2,4,6])for(const explicit of [false,true]){
  const colors=[0,4].includes(type)?1:3,channels=colors+([4,6].includes(type)?1:0),samples=Buffer.alloc(channels*2);for(let i=0;i<channels;i++)samples.writeUInt16BE(32768+i*91,i*2);const raw=png16(1,1,type,samples),bytes=Buffer.concat([raw.subarray(0,33),pngChunk('gAMA',gamma),...(explicit?[pngChunk('cHRM',xy)]:[]),raw.subarray(33)]);const source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);const pdf=await service.render(workspace,source,{dpi:180},[]),{doc,files}=await pdfAttachments(pdf),objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict),image=objects.lookup(objects.keys()[0],PDFRawStream),space=image.dict.lookup(PDFName.of('ColorSpace'),PDFArray),values=space.lookup(1,PDFDict);expect(space.get(0).toString()).toBe(colors===1?'/CalGray':'/CalRGB');const metadata=JSON.parse(files.get('omicos-assembly-provenance.json')!.toString()).pdfDetails.sourceEncodings[0].color;expect(metadata.decodingExponent).toBe(2);expect(metadata.assumptions.length).toBe(explicit?0:1);const white=values.lookup(PDFName.of('WhitePoint'),PDFArray).asArray().map(value=>Number(value.toString()));expect(white[0]).toBeCloseTo(.950456,5);expect(white[1]).toBe(1);expect(white[2]).toBeCloseTo(1.089058,5);if(colors===3){const matrix=values.lookup(PDFName.of('Matrix'),PDFArray).asArray().map(value=>Number(value.toString()));expect(matrix[0]).toBeCloseTo(.412391,5);expect(matrix[4]).toBeCloseTo(.715169,5);expect(matrix[8]).toBeCloseTo(.950532,5);expect(values.lookup(PDFName.of('Gamma'),PDFArray).asArray().map(value=>Number(value.toString()))).toEqual([2,2,2])}else expect(values.get(PDFName.of('Gamma'))!.toString()).toBe('2');expect(Buffer.from(decodePDFRawStream(image).decode())).toEqual(samples.subarray(0,colors*2));if(channels>colors)expect(Buffer.from(decodePDFRawStream(image.dict.lookup(PDFName.of('SMask'),PDFRawStream)).decode())).toEqual(samples.subarray(colors*2));if(type===2&&explicit&&process.env.OMICOS_PDF_QA_DIR)await writeFile(join(process.env.OMICOS_PDF_QA_DIR,'gamma-publication.pdf'),pdf)
 }
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},30000)

it('rejects incompatible, oversized and malformed ICC/color declarations instead of silently falling back',async()=>{
 const workspace=await directory();const service=new PdfPublications(),profile=await readFile(new URL('../runtime/color-profiles/srgb-lcms216.icc',import.meta.url));const raw=png16(1,1,2,Buffer.from([0,1,0,2,0,3]));const icc=(data:Buffer)=>pngChunk('iCCP',Buffer.concat([Buffer.from('ICC\0\0'),deflateSync(data)]));
 async function rejects(parts:Buffer[],pattern:RegExp,base=raw){const bytes=Buffer.concat([base.subarray(0,33),...parts,base.subarray(33)]),source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);await expect(service.render(workspace,source,{dpi:180},[])).rejects.toThrow(pattern)}
 try{
  await rejects([icc(profile),icc(profile)],/Duplicate/);await rejects([icc(profile),pngChunk('sRGB',Buffer.from([0]))],/both/);await rejects([icc(profile)],/channels/,png16(1,1,0,Buffer.from([0,1])));
  const malformed=Buffer.from(profile);malformed.writeUInt32BE(0x7fffffff,136);await rejects([icc(malformed)],/tag bounds/);await rejects([icc(Buffer.alloc(4000001))],/buffer|length|size/i);
  await rejects([pngChunk('sRGB',Buffer.from([4]))],/intent/);await rejects([pngChunk('gAMA',Buffer.alloc(4))],/gamma/);const gamma=Buffer.alloc(4);gamma.writeUInt32BE(50000);await rejects([pngChunk('cHRM',Buffer.alloc(32))],/transfer/);await rejects([pngChunk('gAMA',gamma),pngChunk('cHRM',Buffer.alloc(32))],/chromaticity/);
  const bytes=Buffer.concat([raw.subarray(0,raw.length-12),pngChunk('sRGB',Buffer.from([0])),raw.subarray(raw.length-12)]),source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);await expect(service.render(workspace,source,{dpi:180},[])).rejects.toThrow(/chunk order/);
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},15000)

it('accepts only absent or identity EXIF main-image orientation and retains original metadata bytes',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{for(const orientation of [1,6]){const exif=Buffer.alloc(26);exif.write('II');exif.writeUInt16LE(42,2);exif.writeUInt32LE(8,4);exif.writeUInt16LE(1,8);exif.writeUInt16LE(0x112,10);exif.writeUInt16LE(3,12);exif.writeUInt32LE(1,14);exif.writeUInt16LE(orientation,18);const bytes=Buffer.concat([png.subarray(0,33),pngChunk('eXIf',exif),png.subarray(33)]),source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);if(orientation===6){await expect(service.render(workspace,source,{dpi:180},[])).rejects.toThrow(/orientation transformation/);continue}const {files}=await pdfAttachments(await service.render(workspace,source,{dpi:180},[]));expect(files.get('original-source-r2.png')).toEqual(bytes);expect(JSON.parse(files.get('omicos-assembly-provenance.json')!.toString()).pdfDetails.sourceEncodings[0].exif.mainImageOrientation).toBe(1)}
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it('exports an actual R PNG with platform-generated color metadata without rerunning or changing source bytes',async(context)=>{
 try{await promisify(execFile)('Rscript',['--vanilla','-e','stopifnot(capabilities("png"))'],{timeout:10000})}catch{context.skip();return}
 const workspace=await directory();const service=new PdfPublications()
 try{const path=join(workspace,'r.png');await promisify(execFile)('Rscript',['--vanilla','-e',`png(${JSON.stringify(path)},width=400,height=300);plot(1:3,col=c("red","green","blue"));dev.off()`],{timeout:10000});const bytes=await readFile(path),source=fixture();source.images[0]={...source.images[0],bytes,width:400,height:300};source.images[0].figure.artifact.sha256=hash(bytes);const pdf=await service.render(workspace,source,{dpi:180},[]);expect((await pdfAttachments(pdf)).files.get('original-source-r2.png')).toEqual(bytes);expect(await readFile(path)).toEqual(bytes);if(process.env.OMICOS_PDF_QA_DIR)await writeFile(join(process.env.OMICOS_PDF_QA_DIR,'r-color-publication.pdf'),pdf)
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
},20000)

it('keeps the saved white page policy when a PNG suggests another background',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{const bytes=Buffer.concat([png.subarray(0,33),pngChunk('bKGD',Buffer.from([0,0])),png.subarray(33)]),source=fixture();source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes);const {doc,files}=await pdfAttachments(await service.render(workspace,source,{dpi:180},[]));const objects=doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);expect(Buffer.from(decodePDFRawStream(objects.lookup(objects.keys()[0],PDFRawStream)).decode())).toEqual(Buffer.from([255]));expect(JSON.parse(files.get('omicos-assembly-provenance.json')!.toString()).pdfDetails.sourceEncodings[0].background).toMatchObject({originalHex:'0000',policy:expect.stringContaining('white')});expect(files.get('original-source-r2.png')).toEqual(bytes)
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})

it('exports page-only PDF with identical page/font/image content and no hidden source records, document metadata or attachments',async()=>{
 const workspace=await directory();const service=new PdfPublications();const marker='PRIVATE_SOURCE_SENTINEL_293841';const source=fixture();source.record.title=marker+'-title';source.record.caption=marker+'-caption';(source.metadata as any).execution={code:marker+'-code',path:'/private/'+marker};const bytes=Buffer.concat([png.subarray(0,33),pngChunk('tEXt',Buffer.from('Comment\0'+marker+'-image-metadata')),png.subarray(33)]);source.images[0].bytes=bytes;source.images[0].figure.artifact.sha256=hash(bytes)
 try{
  const fullPdf=await service.render(workspace,source,{dpi:180,attachments:'provenance'},[]);const full=await pdfAttachments(fullPdf);expect(full.files.size).toBe(3);expect(full.files.get('omicos-assembly-provenance.json')!.toString()).toContain(marker);expect(full.doc.getTitle()).toContain(marker);
  const fontPath='fonts/'+marker+'.ttf';const fontBytes=await readFile(bundled);await writeFile(join(workspace,fontPath),fontBytes);const pdf=await service.render(workspace,source,{dpi:180,attachments:'none',font:{path:fontPath,sha256:hash(fontBytes),licenseDeclaration:marker+'-owner-declaration'}},[]);const plain=await pdfAttachments(pdf);expect(plain.files.size).toBe(0);expect(plain.doc.catalog.has(PDFName.of('Names'))).toBe(false);expect(plain.doc.catalog.has(PDFName.of('Metadata'))).toBe(false);expect(plain.doc.context.trailerInfo.Info).toBeUndefined();expect(plain.doc.getTitle()).toBeUndefined();expect(plain.doc.getSubject()).toBeUndefined();expect(plain.doc.getPage(0).getSize()).toEqual(full.doc.getPage(0).getSize());
  for(const document of [plain.doc,full.doc]){const images=document.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);expect(Buffer.from(decodePDFRawStream(images.lookup(images.keys()[0],PDFRawStream)).decode())).toEqual(Buffer.from([255]));const fonts=document.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);expect(fonts.keys().length).toBe(1)}
  for(const [,object] of plain.doc.context.enumerateIndirectObjects()){expect(object.toString()).not.toContain(marker);if(object instanceof PDFRawStream)expect(Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')).not.toContain(marker)}
  if(process.env.OMICOS_PDF_QA_DIR){await writeFile(join(process.env.OMICOS_PDF_QA_DIR,'page-only-publication.pdf'),pdf);await writeFile(join(process.env.OMICOS_PDF_QA_DIR,'page-only-reference.pdf'),fullPdf)}
 }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
})
it('rejects unknown export/attachment fields before source capture rather than falling back to including private attachments',async()=>{
 const service=new PdfPublications();let read=false;const source=async()=>{read=true;return fixture()}
 try{for(const profile of [{dpi:180,attachments:'page-only'},{dpi:180,attachments:null},{dpi:180,attachSources:false},{dpi:180,font:{path:'a.ttf',sha256:'a'.repeat(64),licenseDeclaration:'allowed',attachments:'none'}}]){expect(()=>service.render('/not-read',source,profile as any,[])).toThrow();expect(read).toBe(false)}expect(publicationProfile({dpi:180}).attachments).toBe('provenance');expect(publicationProfile({dpi:180,attachments:'none'}).attachments).toBe('none')
 }finally{await service.dispose()}
})
