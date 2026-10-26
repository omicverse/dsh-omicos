/** Explicit online fixture; never part of the default offline scientific test suite. */
const {spawn,execFile}=require('node:child_process');const {promisify}=require('node:util');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
(async()=>{
 if(!process.argv.includes('--online'))throw Error('Pass --online to approve downloading a small PyPI wheel into a temporary isolated venv')
 const metadata=await(await fetch('https://pypi.org/pypi/packaging/24.2/json')).json();const wheel=metadata.urls.find(item=>item.filename==='packaging-24.2-py3-none-any.whl');if(!/^[a-f0-9]{64}$/.test(wheel?.digests?.sha256))throw Error('PyPI fixture hash not available')
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omicos-provision-pypi-'));let host
 try{
  host=spawn(process.execPath,['lib/oss/cli.js','--workspace',path.join(directory,'project'),'--state-dir',path.join(directory,'state'),'--python',process.env.OMICOS_SCIENCE_TEST_PYTHON||'python3','--port','0'],{stdio:['ignore','pipe','pipe']})
  const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Host startup timeout')),10000);host.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/);if(match){clearTimeout(timer);resolve(new URL(match[0]))}});host.stderr.on('data',chunk=>process.stderr.write(chunk));host.once('exit',code=>{clearTimeout(timer);reject(Error('Host exited '+code))})})
  const headers={authorization:`Bearer ${url.searchParams.get('omicos_token')}`};const session=await(await fetch(url.origin+'/omicos/oss/api/session',{headers})).json();const prefix=`${url.origin}/omicos/oss/api/project/${session.projects[0].id}/managed-environment-`
  const request=await fetch(prefix+'install',{method:'POST',headers:{...headers,'content-type':'application/json','x-omicos-csrf':session.csrf},body:JSON.stringify({confirmed:true,install:{operationId:'online-fixture',title:'Temporary public PyPI fixture',packages:[{name:'packaging',version:'24.2',sha256:[wheel.digests.sha256]}]}})});if(!request.ok)throw Error('Online install rejected');let record=await request.json()
  const deadline=Date.now()+120000;while(['preparing','installing','verifying'].includes(record.state)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,200));record=await(await fetch(prefix+`document?id=${record.id}`,{headers})).json()}
  if(record.state!=='ready')throw Error(record.error||'Online installation did not become ready')
  const result=await promisify(execFile)(record.interpreter,['-I','-B','-c','import packaging; print(packaging.__version__)'],{timeout:10000});if(result.stdout.trim()!=='24.2')throw Error('Downloaded package did not execute at the pinned version')
  console.log(JSON.stringify({source:'public PyPI',wheel:'packaging-24.2-py3-none-any.whl',sha256:wheel.digests.sha256,installedVersion:record.installed.packaging,manifest:record.manifestSha256,selection:'unchanged; temporary environment removed'}))
 }finally{if(host&&host.exitCode===null&&host.signalCode===null){const exited=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGTERM');const force=setTimeout(()=>host.kill('SIGKILL'),5000);await exited;clearTimeout(force)}await fs.rm(directory,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1})
