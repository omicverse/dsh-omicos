const {spawn,spawnSync}=require('node:child_process');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
(async()=>{
 if(process.platform==='win32'){console.log(JSON.stringify({provisionWatchdog:'unverified on Windows'}));return}
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omicos-provision-orphan-'));let host;let installerPid
 const marker=path.join(directory,'installer-pid');const bad=path.join(directory,'must-not-finish');const wrapper=path.join(directory,'slow-python')
 const launch=async()=>{host=spawn(process.execPath,['lib/oss/cli.js','--workspace',path.join(directory,'project'),'--state-dir',path.join(directory,'state'),'--python',wrapper,'--port','0'],{stdio:['ignore','pipe','pipe']});return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Installer fixture Host startup timed out')),10000);host.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/);if(match){clearTimeout(timer);resolve(new URL(match[0]))}});host.stderr.on('data',chunk=>process.stderr.write(chunk));host.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture Host exited '+code))})})}
 try{
  await fs.writeFile(wrapper,`#!/usr/bin/env python3\nimport os,time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(30)\nPath(${JSON.stringify(bad)}).write_text('unexpected')\n`,{mode:0o700})
  let url=await launch();let headers={authorization:`Bearer ${url.searchParams.get('omicos_token')}`};let session=await(await fetch(url.origin+'/omicos/oss/api/session',{headers})).json();const project=session.projects[0].id
  const response=await fetch(`${url.origin}/omicos/oss/api/project/${project}/managed-environment-install`,{method:'POST',headers:{...headers,'content-type':'application/json','x-omicos-csrf':session.csrf},body:JSON.stringify({confirmed:true,install:{operationId:'host-death',title:'Installer lifetime fixture',packages:[]}})});if(!response.ok)throw Error('Installer start rejected');const record=await response.json()
  for(let count=0;count<200;count++){try{installerPid=Number(await fs.readFile(marker,'utf8'));if(Number.isSafeInteger(installerPid)&&installerPid>1)break}catch{}await new Promise(resolve=>setTimeout(resolve,20))}
  if(!Number.isSafeInteger(installerPid)||installerPid<2)throw Error('Actual installer did not start')
  const exited=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGKILL');await exited
  let alive=true;for(let count=0;count<200;count++){try{process.kill(installerPid,0);const status=spawnSync('ps',['-p',String(installerPid),'-o','stat='],{encoding:'utf8'});if(status.status===1||status.stdout?.trim().startsWith('Z')){alive=false;break}}catch(error){if(error.code==='ESRCH'){alive=false;break}throw error}await new Promise(resolve=>setTimeout(resolve,20))}
  if(alive)throw Error('Installer survived Host SIGKILL');await fs.access(bad).then(()=>{throw Error('Orphan installation reached a delayed side effect')},error=>{if(error.code!=='ENOENT')throw error})
  // The previous Host is confirmed dead above. Respect the existing 10 s stale-lock grace.
  const lock=await fs.stat(path.join(directory,'project','.omicos-oss','runtime.lock'));await new Promise(resolve=>setTimeout(resolve,Math.max(0,11000-(Date.now()-lock.mtimeMs))))
  url=await launch();headers={authorization:`Bearer ${url.searchParams.get('omicos_token')}`};const recovered=await(await fetch(`${url.origin}/omicos/oss/api/project/${project}/managed-environment-document?id=${record.id}`,{headers})).json();if(recovered.state!=='interrupted')throw Error('Killed installation did not recover as interrupted')
  const listing=await(await fetch(`${url.origin}/omicos/oss/api/project/${project}/managed-environment-list`,{headers})).json();if(listing.selection.environmentId!==null)throw Error('Partial installation was selected')
  console.log(JSON.stringify({provisionWatchdog:'actual Python installer exits after Host SIGKILL before delayed side effect',recovery:'interrupted; not resumed or selected'}))
 }finally{
  if(host&&host.exitCode===null&&host.signalCode===null){const exited=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGTERM');const force=setTimeout(()=>host.kill('SIGKILL'),3000);await exited;clearTimeout(force)}
  if(installerPid){try{const command=spawnSync('ps',['-p',String(installerPid),'-o','command='],{encoding:'utf8'}).stdout||'';if(command.includes(wrapper))process.kill(installerPid,'SIGKILL')}catch{}}
  await fs.rm(directory,{recursive:true,force:true})
 }
})().catch(error=>{console.error(error);process.exitCode=1})
