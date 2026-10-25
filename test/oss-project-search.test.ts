import {createRequire} from 'node:module'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtemp,mkdir,rm,stat,symlink,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ScienceLedger} from '../src/oss/ledger.js'
import {ProjectDossier} from '../src/oss/dossier.js'
import {searchProjects} from '../src/oss/project-search.js'
let root:string
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'oss-search-')))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
it('searches actual immutable memory/dossier metadata without creating a missing project, includes private notes only explicitly, and binds pagination',async()=>{
 const first=join(root,'a'),missing=join(root,'missing');await mkdir(first);const ledger=await ScienceLedger.open(first),owner={owner:true,actor:'user:test'}
 const propose=(text:string,scope:'project'|'session',operationId:string)=>ledger.memory.propose({title:'Reference',text,kind:'fact',scope,...scope==='session'?{sessionId:'private'}:{},sources:[{kind:'user',ref:'Researcher'}],operationId},owner)
 const shared=propose('Human GRCh38 samples','project','shared');ledger.memory.transition({id:shared.id,revision:shared.revision,action:'confirm',operationId:'confirm'},owner);propose('Human private diagnosis','session','private')
 const dossier=await ProjectDossier.open(first,async()=>({scope:first,data:{evidence:'declared'}}));await dossier.save({operationId:'save',title:'Human finding',finding:'Interpretation',limitations:'Not validated',tags:[],sources:[{kind:'method',id:'source'}]},'user:test')
 const projects=[{id:'a',workspace:first},{id:'b',workspace:missing}],page=await searchProjects(projects,'Human');expect(page.hits.map(hit=>hit.preview)).toEqual(['Human GRCh38 samples']);expect(page.hits[0].revision).toBe(2)
 const privatePage=await searchProjects(projects,'Human',true);expect(privatePage.hits).toHaveLength(2)
 const second=await searchProjects(projects,'Human',false,page.next);expect(second.kind).toBe('dossier');expect(second.hits[0].title).toBe('Human finding');expect(second.hits[0]).not.toHaveProperty('sources')
 const absent=await searchProjects(projects,'Human',false,second.next);expect(absent.unavailable).toContain('absent');await expect(stat(missing)).rejects.toMatchObject({code:'ENOENT'})
 await expect(searchProjects(projects,'Other',false,page.next)).rejects.toMatchObject({status:409});await expect(searchProjects(projects.slice(0,1),'Human',false,page.next)).rejects.toMatchObject({status:409})
 await expect(searchProjects(projects,'')).rejects.toMatchObject({status:400});ledger.close();await dossier.dispose()
})
it('advances bounded raw pages despite no matches and rejects linked metadata',async()=>{
 const workspace=join(root,'project');await mkdir(workspace);const ledger=await ScienceLedger.open(workspace)
 for(let i=0;i<55;i++)ledger.memory.propose({title:'No match',text:'Other',kind:'fact',scope:'project',sources:[{kind:'user',ref:'Researcher'}],operationId:`op-${i}`},{owner:true,actor:'user:test'})
 const projects=[{id:'a',workspace}],first=await searchProjects(projects,'Needle',true);expect(first.scanned).toBe(50);expect(first.hits).toEqual([]);const next=await searchProjects(projects,'Needle',true,first.next);expect(next.scanned).toBe(5);expect(next.kind).toBe('memory');ledger.close()
 const linked=join(root,'linked');await mkdir(linked);await symlink(join(workspace,'.omicos-oss'),join(linked,'.omicos-oss'));expect((await searchProjects([{id:'linked',workspace:linked}],'Needle')).unavailable).toContain('identity changed')
})

it('reports altered memory records without forwarding their text',async()=>{
 const workspace=join(root,'changed');await mkdir(workspace);const ledger=await ScienceLedger.open(workspace)
 ledger.memory.propose({title:'Original',text:'Needle',kind:'fact',scope:'project',sources:[{kind:'user',ref:'Fixture'}],operationId:'original'},{owner:true,actor:'user:test'});ledger.close()
 const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');const db=new DatabaseSync(join(workspace,'.omicos-oss','project.sqlite'));db.exec("UPDATE memories SET record_json=json_set(record_json,'$.text','Forged Needle')");db.close()
 const page=await searchProjects([{id:'a',workspace}],'Needle',true);expect(page.hits).toEqual([]);expect(page.unavailable).toContain('identity was changed')
})
