import {expect,it} from 'vitest'
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {FigureStudio} from '../src/oss/figures.js'
import {FigureAssemblies,assemblyLayout,pngDimensions} from '../src/oss/assemblies.js'
import {OssRuntime} from '../src/oss/runtime.js'
import type {AssemblyDraft,AssemblyLayout} from '../src/oss/assembly-types.js'
import type {Execution,Artifact} from '../src/oss/types.js'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64')
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'oss-assemblies-'));await mkdir(join(directory,'.omicos-oss'))
  let bytes=png;let calls=0;const artifact:Artifact={id:'png',path:'.omicos-oss/plot.png',mime:'image/png',bytes:png.length,sha256:sha(png)}
  const execution:Execution={id:'execution',operationId:'operation',language:'python',sessionId:'fixture',state:'succeeded',code:'fixture_plot()',output:'',artifacts:[artifact],createdAt:'2026-10-25'}
  const figures=await FigureStudio.open(directory,async()=>{calls++;return {bytes,artifact,execution}})
  const figure=await figures.save({title:'Original source',caption:'Declared interpretation',source:{kind:'project',language:'python',executionId:'execution',artifactId:'png'},methods:[],dataReferences:[],operationId:'source'},'fixture')
  let assemblies=await FigureAssemblies.open(directory,figures)
  const draft=(operationId:string,revision=figure.revision):AssemblyDraft=>({title:'Assembly',caption:'Source preserved',operationId,layout:{width:600,height:400,panels:[{figureId:figure.id,figureRevision:revision,x:10,y:10,width:580,height:380,label:'A'}]}})
  return {directory,figures,figure,draft,get assemblies(){return assemblies},get calls(){return calls},change:(value:Buffer)=>{bytes=value},artifact,async reopen(){await assemblies.dispose();assemblies=await FigureAssemblies.open(directory,figures)},async close(){await assemblies.dispose();await figures.dispose();await rm(directory,{recursive:true,force:true})}}
}
it('pins authoritative source versions, embeds exact original PNGs and escapes all SVG text without active/external content',async()=>{
  const f=await fixture()
  try{
    const request={...f.draft('save'),title:'<script>Title</script>',caption:'<&> caption',sources:[{figure:{title:'Forged'}}]}
    request.layout.panels[0].label='<script>bad()</script>'
    const board=await f.assemblies.save(request,'fixture:user');expect(board.sources[0].figure.title).toBe('Original source')
    const svg=(await f.assemblies.svg(board.id)).toString()
    const embedded=svg.match(/href="data:image\/png;base64,([^"]+)"/)![1];expect(Buffer.from(embedded,'base64')).toEqual(png)
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');expect(svg).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(svg).not.toMatch(/<script|<foreignObject|href="https?:|<!DOCTYPE/i)
    expect(svg).toContain('Original source');expect(svg).toContain(sha(png))
    expect((await f.assemblies.save(request,'fixture:user')).id).toBe(board.id)
    await expect(f.assemblies.save(request,'harness:another')).rejects.toMatchObject({status:409})
    await f.reopen();expect(f.assemblies.get(board.id).digest).toBe(board.digest)
  }finally{await f.close()}
})
it('requires exact current approved source revisions for new human review and preserves historical exports after metadata drift',async()=>{
  const f=await fixture()
  try{
    let board=await f.assemblies.save(f.draft('first'),'fixture')
    await expect(f.assemblies.review({id:board.id,revision:1,operationId:'not-reviewed',decision:'approved',note:'Source still draft'})).rejects.toMatchObject({status:409})
    const source=await f.figures.review({id:f.figure.id,revision:1,decision:'approved',note:'Checked source axes',operationId:'source-review'},'human')
    const recapture={...f.draft('recapture',source.revision),id:board.id,revision:board.revision}
    board=await f.assemblies.save(recapture,'fixture');expect(board.review.state).toBe('draft')
    const review={id:board.id,revision:board.revision,operationId:'review',decision:'approved' as const,note:'Layout and individual source reviewed'}
    const approved=await f.assemblies.review(review);expect(approved.review.assessedDigest).toBe(board.digest)
    await f.figures.save({id:source.id,revision:source.revision,title:'Changed source caption',caption:'New interpretation',source:source.source,methods:[],dataReferences:[],operationId:'source-edit'},'human')
    expect((await f.assemblies.integrity(approved.id)).state).toBe('needs-review')
    await expect(f.assemblies.review({...review,revision:approved.revision,operationId:'stale-review'})).rejects.toMatchObject({status:409})
    const historical=(await f.assemblies.svg(board.id,approved.revision)).toString();expect(historical).toContain('needs-review');expect(historical).toContain('Original source');expect(historical).not.toContain('Changed source caption')
    const changed=await f.assemblies.save({...recapture,revision:approved.revision,operationId:'edit',caption:'Layout changes reset assessment'},'human')
    expect(changed.review.state).toBe('draft');expect((await f.assemblies.review(review)).review.state).toBe('draft')
    expect(f.assemblies.get(board.id,approved.revision).review.state).toBe('approved')
    await expect(f.assemblies.save({...recapture,operationId:'stale-edit'},'human')).rejects.toMatchObject({status:409})
    f.change(Buffer.from('tampered'))
    await expect(f.assemblies.svg(board.id,approved.revision)).rejects.toThrow(/matches|changed/)
    expect(f.assemblies.manifest(board.id,approved.revision).assembly.sources[0].figure.artifact.sha256).toBe(sha(png))
    expect((await f.assemblies.integrity(board.id)).state).toBe('needs-review')
    expect((await f.assemblies.review({id:board.id,revision:changed.revision,decision:'withdrawn',operationId:'withdraw',note:'Source unavailable; preserve history'})).review.state).toBe('withdrawn')
  }finally{await f.close()}
})
it('bounds geometry, source format/pixels and repeated-panel bytes before encoding, with complete paginated history',async()=>{
  const f=await fixture()
  try{
    const layout=f.draft('layout').layout
    for(const input of [{...layout,width:Infinity},{...layout,width:8000,height:8000},{...layout,panels:[]},{...layout,panels:[{...layout.panels[0],x:10000}]},{...layout,panels:[layout.panels[0],layout.panels[0]]}])expect(()=>assemblyLayout(input)).toThrow()
    expect(()=>pngDimensions(Buffer.from('not png'))).toThrow()
    const huge=Buffer.from(png);huge.writeUInt32BE(10000,16);huge.writeUInt32BE(10000,20);expect(()=>pngDimensions(huge)).toThrow(/25 million/)
    let last=await f.assemblies.save(f.draft('original'),'fixture')
    for(let index=0;index<51;index++)last=await f.assemblies.save({...f.draft(`edit-${index}`),id:last.id,revision:last.revision},'fixture')
    const history=f.assemblies.history(last.id);expect(history.revisions).toHaveLength(50);expect(f.assemblies.history(last.id,history.next).revisions.map(row=>row.revision)).toEqual([2,1])
    for(let index=0;index<51;index++)await f.assemblies.save({...f.draft(`board-${index}`),title:`Collection ${index}`},'fixture')
    const page=f.assemblies.list();expect(page.entries).toHaveLength(50);expect(f.assemblies.list('',page.next).entries).toHaveLength(2)
    expect(f.assemblies.list('Collection 50').entries).toHaveLength(1)
    const large=Buffer.concat([png,Buffer.alloc(3000000)]);f.change(large);f.artifact.sha256=sha(large);f.artifact.bytes=large.length
    const source=await f.figures.save({title:'Budget fixture',caption:'',source:f.figure.source,methods:[],dataReferences:[],operationId:'large-source'},'fixture')
    const repeated:AssemblyLayout={width:800,height:800,panels:Array.from({length:16},(_,index)=>({figureId:source.id,figureRevision:1,x:index%4*200,y:Math.floor(index/4)*200,width:200,height:200,label:String(index)}))}
    await expect(f.assemblies.save({...f.draft('repeated'),layout:repeated},'fixture')).rejects.toMatchObject({status:413})
  }finally{await f.close()}
})
it.skipIf(!process.env.OMICOS_SCIENCE_TEST_PYTHON)('assembles real Python PNGs, keeps execution provenance through restart and refuses changed source bytes without rerunning',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oss-real-assembly-'));let runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:process.env.OMICOS_SCIENCE_TEST_PYTHON})
  try{
    let project=await runtime.project(join(directory,'project'));const job=await project.submit('import matplotlib.pyplot as plt\nplt.plot([1,2],[3,4])\nplt.title("Original data")\nplt.figure()\nplt.plot([1,2],[4,2])\nplt.title("Second original")','plot','fixture')
    for(let index=0;index<500&&!['succeeded','failed'].includes(project.get(job.id)!.state);index++)await new Promise(resolve=>setTimeout(resolve,20))
    const receipt=project.get(job.id)!;expect(receipt.state).toBe('succeeded');const artifact=receipt.artifacts.find(item=>item.mime==='image/png')!
    const original=await readFile(join(project.workspace,artifact.path));const figures=await runtime.figures(project.workspace)
    const source=await figures.save({title:'Real Python source',caption:'Actual data',source:{kind:'project',language:'python',executionId:job.id,artifactId:artifact.id},methods:[],dataReferences:[],operationId:'curate'},'fixture')
    const approved=await figures.review({id:source.id,revision:1,decision:'approved',note:'Human test assessment',operationId:'approve-source'},'human')
    const secondArtifact=receipt.artifacts.filter(item=>item.mime==='image/png')[1]!;expect(secondArtifact).toBeTruthy();const secondBytes=await readFile(join(project.workspace,secondArtifact.path));expect(sha(secondBytes)).not.toBe(sha(original))
    const second=await figures.save({title:'Second actual PNG',caption:'Independent panel',source:{kind:'project',language:'python',executionId:job.id,artifactId:secondArtifact.id},methods:[],dataReferences:[],operationId:'curate-second'},'fixture')
    const secondApproved=await figures.review({id:second.id,revision:1,decision:'approved',note:'Second source review',operationId:'approve-second'},'human')
    let assemblies=await runtime.assemblies(project.workspace);const board=await assemblies.save({title:'Publication draft',caption:'Exact source bytes',operationId:'assemble',layout:{width:1000,height:600,panels:[{figureId:approved.id,figureRevision:approved.revision,x:20,y:20,width:460,height:560,label:'A'},{figureId:secondApproved.id,figureRevision:secondApproved.revision,x:520,y:20,width:460,height:560,label:'B'}]}},'human')
    await assemblies.review({id:board.id,revision:1,operationId:'approve-layout',decision:'approved',note:'Checked fit and original source'})
    const svg=(await assemblies.svg(board.id)).toString();expect(Buffer.from(svg.match(/base64,([^"]+)/)![1],'base64')).toEqual(original)
    expect(svg).toContain(secondBytes.toString('base64'));expect((svg.match(/<image /g)||[]).length).toBe(2)
    expect(svg).toContain(receipt.environment!.fingerprint);expect(svg).toContain(job.id)
    await runtime.dispose();runtime=await OssRuntime.open({stateDir:join(directory,'state'),python:process.env.OMICOS_SCIENCE_TEST_PYTHON});project=await runtime.project(join(directory,'project'));assemblies=await runtime.assemblies(project.workspace)
    expect(assemblies.get(board.id).review.state).toBe('approved');expect((await assemblies.svg(board.id)).length).toBeGreaterThan(original.length)
    expect(project.snapshot().executions).toHaveLength(1);expect(project.snapshot().kernel.state).toBe('cold')
    await writeFile(join(project.workspace,artifact.path),'changed after export');await expect(assemblies.svg(board.id)).rejects.toThrow();expect(project.snapshot().executions).toHaveLength(1)
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true})}
},30000)
