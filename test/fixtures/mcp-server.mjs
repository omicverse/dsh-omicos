// Minimal real legacy JSON-RPC MCP endpoint. Harness owns protocol negotiation,
// serving transport and tool/resource projection; this fixture has no SDK mocks.
import {createInterface} from 'node:readline'
import {appendFileSync,existsSync} from 'node:fs'
import {setTimeout} from 'node:timers/promises'
const [eventsPath,releasePath]=process.argv.slice(2)
const record=(event,extra={})=>appendFileSync(eventsPath,`${JSON.stringify({event,pid:process.pid,...extra})}\n`)
record('start');process.once('exit',()=>record('exit'));process.stdin.once('end',()=>process.exit(0))
createInterface({input:process.stdin}).on('line',async line=>{
  const request=JSON.parse(line);if(request.id===undefined)return
  record(request.method)
  if(request.method==='server/discover'){
    while(releasePath&&!existsSync(releasePath))await setTimeout(10)
    process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Legacy fixture'}})}\n`);return
  }
  let result
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'OmicOS test MCP',version:'1'},instructions:'External fixture guidance {{must_stay_literal}}'}
  else if(request.method==='tools/list')result={tools:[{name:'echo',description:'Fixture echo without external services',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}
  else if(request.method==='tools/call'){record('invoked',{text:request.params.arguments.text});result={content:[{type:'text',text:`${request.params.arguments.text}; credential=${Boolean(process.env.FIXTURE_TOKEN)}`} ]}}
  else if(request.method==='resources/list')result={resources:[{uri:'fixture://paper',name:'Paper fixture',mimeType:'text/plain'}]}
  else if(request.method==='resources/templates/list')result={resourceTemplates:[]}
  else if(request.method==='resources/read'){record('read');result={contents:[{uri:request.params.uri,mimeType:'text/plain',text:'Actual project MCP resource'}]}}
  else if(request.method==='ping')result={}
  else{process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}})}\n`);return}
  process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,result})}\n`)
})
