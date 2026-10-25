import {expect,it} from 'vitest'
import {build} from 'esbuild'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib'
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
it('rejects missing glyphs, geometry overflow and unsupported precision/color PNGs instead of silently substituting or transforming',async()=>{
 const workspace=await directory();const service=new PdfPublications()
 try{await expect(service.render(workspace,fixture('科研'),{dpi:180},[])).rejects.toThrow(/lacks label glyphs/);const overflow=fixture('WWWWWWWWWW');overflow.record.layout.panels[0].width=80;await expect(service.render(workspace,overflow,{dpi:180},[])).rejects.toThrow(/exceeds its panel/)
  const high=fixture();high.images[0].bytes=Buffer.from(png);high.images[0].bytes[24]=16;high.images[0].figure.artifact.sha256=hash(high.images[0].bytes);await expect(service.render(workspace,high,{dpi:180},[])).rejects.toThrow(/16-bit/)
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
