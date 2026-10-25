import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devNull } from 'node:os'
import { workerEnvironment } from './worker-environment.js'
import { workspacePath } from './files.js'
import { EnvironmentError, type EnvironmentInstallRequest, type LockedPackage, type ManagedPythonEnvironment, type EnvironmentSelection } from './environment-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const supervisor = fileURLToPath(new URL('../../runtime/provision_watchdog.cjs', import.meta.url))
const manifestScript = fileURLToPath(new URL('../../runtime/environment_manifest.py', import.meta.url))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const active = new Set(['preparing','installing','verifying'])
const identity = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new EnvironmentError(400,'Invalid environment/operation identity'); return value }
const cursor = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw new EnvironmentError(400,'Invalid environment cursor'); return value }
export function normalizeEnvironmentInstall(input: EnvironmentInstallRequest): EnvironmentInstallRequest {
  if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !Array.isArray(input.packages) || input.packages.length > 200) throw new EnvironmentError(400,'An environment needs a title and at most 200 hash-locked packages')
  identity(input.operationId)
  const packages: LockedPackage[] = input.packages.map(item => {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(item.name) || typeof item.version !== 'string' || !/^[0-9][A-Za-z0-9.!+_-]{0,99}$/.test(item.version) || !Array.isArray(item.sha256) || !item.sha256.length || item.sha256.length > 50 || item.sha256.some(value=>typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value))) throw new EnvironmentError(400,'Every package needs an exact version and SHA-256 wheel hashes; options/URLs/markers are not accepted')
    return { name: item.name.toLowerCase().replace(/[-_.]+/g,'-'), version: item.version, sha256: [...new Set(item.sha256.map(value=>value.toLowerCase()))].sort() }
  }).sort((a,b)=>a.name.localeCompare(b.name))
  if (new Set(packages.map(item=>item.name)).size !== packages.length) throw new EnvironmentError(400,'Duplicate locked package')
  if (input.wheelDirectory !== undefined && (typeof input.wheelDirectory !== 'string' || !input.wheelDirectory.trim() || input.wheelDirectory.length > 2000)) throw new EnvironmentError(400,'Invalid offline wheel directory')
  return { operationId: input.operationId, title: input.title, packages, ...(input.wheelDirectory !== undefined ? { wheelDirectory: input.wheelDirectory } : {}) }
}
/** One project-owned installer; environments are immutable after ready and never auto-selected. */
export class ManagedEnvironments {
  private task?: Promise<void>
  private commandTask?: Promise<string>
  private selectionPending = 0
  private child?: ChildProcess
  private killed = new WeakSet<ChildProcess>()
  private stopping?: string
  private closing = false
  private disposing?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private constructor(private db: Database, readonly workspace: string, readonly basePython: string, private sensitive: readonly string[]) {}
  static async open(workspace: string, basePython: string, sensitive: readonly string[]): Promise<ManagedEnvironments> {
    const directory = join(workspace,'.omicos-oss','environments'); await mkdir(directory,{recursive:true,mode:0o700})
    if (await realpath(directory) !== directory) throw new EnvironmentError(403,'Managed environment directory cannot be a symbolic link')
    const path = join(workspace,'.omicos-oss','environments.sqlite'); const file = await open(path,'a',0o600); await file.close(); await chmod(path,0o600)
    const db = new DatabaseSync(path)
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 1 || (application !== 0 && application !== 0x4f454e56) || (version && application !== 0x4f454e56)) throw new Error('Unsupported managed environment database; preserve it and use a compatible runtime')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (!version) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unknown managed environment database')
        db.exec(`BEGIN IMMEDIATE; CREATE TABLE environments(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL); CREATE TABLE selection(revision INTEGER PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL); INSERT INTO selection VALUES(1,'{"revision":1,"environmentId":null,"at":"initial"}'); PRAGMA application_id=${0x4f454e56}; PRAGMA user_version=1; COMMIT;`)
      }
      const service = new ManagedEnvironments(db,workspace,basePython,sensitive)
      for (;;) { const rows = db.prepare("SELECT id FROM environments WHERE json_extract(record_json,'$.state') IN ('preparing','installing','verifying') LIMIT 50").all(); if (!rows.length) break; for (const row of rows) service.update(String(row.id),{state:'interrupted',error:'Host stopped. Inspect the partial environment; a new explicitly approved installation is required.'}) }
      return service
    } catch(error) { db.close(); throw error }
  }
  private directory(id: string) { identity(id); return join(this.workspace,'.omicos-oss','environments',id) }
  private async safeDirectory(id: string) { const path = this.directory(id); if (await realpath(path) !== path) throw new EnvironmentError(403,'Environment path changed or became a symbolic link'); return path }
  get(id: string): ManagedPythonEnvironment { identity(id); const row = this.db.prepare('SELECT record_json FROM environments WHERE id=?').get(id); if (!row) throw new EnvironmentError(404,'Managed environment not found'); const record = JSON.parse(String(row.record_json)) as ManagedPythonEnvironment; if (record.id !== id || record.interpreter !== join(this.directory(id),'venv','bin','python')) throw new EnvironmentError(409,'Managed environment identity changed'); return record }
  private update(id: string, fields: Partial<ManagedPythonEnvironment>) { const record = {...this.get(id),...fields,updatedAt:new Date().toISOString()}; this.db.prepare('UPDATE environments SET record_json=? WHERE id=?').run(JSON.stringify(record),id); return record }
  list(before = Number.MAX_SAFE_INTEGER) { cursor(before); const rows = this.db.prepare('SELECT rowid,id FROM environments WHERE rowid<? ORDER BY rowid DESC LIMIT 51').all(before); return { entries: rows.slice(0,50).map(row=>{const {logTail,packages,...record}=this.get(String(row.id)); return {...record,packages:packages.length}}), next:rows.length>50?Number(rows[49].rowid):undefined, selection:this.selection(), basePython:this.basePython, installSupported:process.platform !== 'win32' } }
  selection(): EnvironmentSelection { const row=this.db.prepare('SELECT revision,record_json FROM selection ORDER BY revision DESC LIMIT 1').get()!;const value=JSON.parse(String(row.record_json)) as EnvironmentSelection;if(value.revision!==Number(row.revision)||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.at!=='string'||!(value.environmentId===null||typeof value.environmentId==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(value.environmentId)))throw new EnvironmentError(409,'Invalid persisted environment selection; preserve and inspect the database');return value }
  selectionHistory(before = Number.MAX_SAFE_INTEGER) { cursor(before); const rows = this.db.prepare('SELECT revision,record_json FROM selection WHERE revision<? ORDER BY revision DESC LIMIT 51').all(before); return { entries: rows.slice(0,50).map(row=>JSON.parse(String(row.record_json)) as EnvironmentSelection), next: rows.length>50?Number(rows[49].revision):undefined } }
  start(input: EnvironmentInstallRequest): ManagedPythonEnvironment {
    if (this.closing) throw new EnvironmentError(409,'Environment manager is closing')
    if (process.platform === 'win32') throw new EnvironmentError(503,'Managed installation is currently verified on POSIX only')
    const normalized = normalizeEnvironmentInstall(input); const {operationId,...definition}=normalized; const requestSha256 = hash(JSON.stringify(definition))
    const previous = this.db.prepare('SELECT id FROM environments WHERE operation_id=?').get(operationId)
    if (previous) { const record = this.get(String(previous.id)); if (record.requestSha256 !== requestSha256) throw new EnvironmentError(409,'Installation operation belongs to another request'); return record }
    if (this.task || this.child || this.selectionPending) throw new EnvironmentError(409,'Another environment installation is still finishing')
    const id = randomUUID(); const at = new Date().toISOString(); const record: ManagedPythonEnvironment = {id,operationId,title:normalized.title,packages:normalized.packages,wheelDirectory:normalized.wheelDirectory,requestSha256,state:'preparing',createdAt:at,updatedAt:at,interpreter:join(this.directory(id),'venv','bin','python'),logTail:''}
    this.db.prepare('INSERT INTO environments VALUES(?,?,?)').run(id,operationId,JSON.stringify(record))
    this.stopping = undefined; const task = this.install(record); this.task = task; void task.finally(()=>{if(this.task===task)this.task=undefined}).catch(()=>{})
    return record
  }
  private env(): NodeJS.ProcessEnv { const env=workerEnvironment(process.env); for (const name of Object.keys(env)) if (/^(PYTHON|VIRTUAL_ENV|CONDA_|R_)/i.test(name)) delete env[name]; return {...env,PIP_CONFIG_FILE:devNull,PIP_DISABLE_PIP_VERSION_CHECK:'1',PIP_NO_INPUT:'1',PYTHONDONTWRITEBYTECODE:'1',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})} }
  private kill(child: ChildProcess) { if(child.exitCode!==null || child.signalCode!==null || this.killed.has(child))return; try { if(child.pid)process.kill(-child.pid,'SIGKILL');this.killed.add(child) } catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error } }
  private command(command: string, args: string[], id?: string): Promise<string> {
    if(process.platform==='win32')return Promise.reject(new EnvironmentError(503,'Managed environment commands are currently verified on POSIX only'))
    if(this.closing || this.stopping) return Promise.reject(new EnvironmentError(409,this.stopping || 'Environment manager is closing'))
    const pending = new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,[supervisor,command,...args],{detached:true,cwd:this.workspace,env:this.env(),stdio:['ignore','pipe','pipe','pipe','pipe']}); this.child=child
      let output='';let result='';let timeout=false;let settled=false
      const timer=setTimeout(()=>{timeout=true;this.kill(child)},30*60*1000)
      const collect=(chunk:Buffer)=>{output=(output+String(chunk)).slice(-64000);if(id) { try {this.update(id,{logTail:(this.get(id).logTail+String(chunk)).slice(-64000)})}catch(error){this.kill(child)} } }
      child.stdout?.on('data',collect);child.stderr?.on('data',collect);child.stdio[3]?.on('data',(chunk:Buffer)=>{result=(result+String(chunk)).slice(-16000)})
      child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);if(this.child===child)this.child=undefined;reject(error)})
      child.once('close',()=>{if(settled)return;settled=true;clearTimeout(timer);if(this.child===child)this.child=undefined
        let status:any;try{status=JSON.parse(result)}catch{}
        if(this.stopping || this.closing || timeout || status?.code!==0)reject(new Error(this.stopping || (timeout?'Environment command timed out':status?.error || output || 'Installer exited without a successful receipt')));else resolve(output)
      })
    })
    this.commandTask = pending; void pending.finally(()=>{if(this.commandTask===pending)this.commandTask=undefined}).catch(()=>{})
    return pending
  }
  private async manifest(record: ManagedPythonEnvironment): Promise<{manifestSha256:string;installed:Record<string,string>;pythonVersion:string}> {
    const directory=await this.safeDirectory(record.id);const venv=join(directory,'venv');if(await realpath(venv)!==venv)throw new EnvironmentError(403,'Virtual environment path changed')
    const output=await this.command(this.basePython,['-I','-S',manifestScript,venv]);const result=JSON.parse(output)
    if(!/^[a-f0-9]{64}$/.test(result.manifestSha256) || !result.installed || typeof result.pythonVersion!=='string')throw new EnvironmentError(409,'Invalid environment manifest')
    return result
  }
  private async install(record: ManagedPythonEnvironment): Promise<void> {
    try {
      const directory=this.directory(record.id);await mkdir(directory,{mode:0o700});await this.safeDirectory(record.id)
      const requirements=join(directory,'requirements.lock');await writeFile(requirements,record.packages.map(item=>`${item.name}==${item.version} ${item.sha256.map(value=>`--hash=sha256:${value}`).join(' ')}`).join('\n')+'\n',{mode:0o600})
      let wheels:string|undefined
      if(record.wheelDirectory!==undefined){
        const source=await workspacePath(this.workspace,record.wheelDirectory,this.sensitive);if(!(await stat(source)).isDirectory())throw new EnvironmentError(400,'Offline wheels must come from a project directory')
        const entries=await readdir(source,{withFileTypes:true});if(entries.length>2000)throw new EnvironmentError(413,'Offline wheel directory exceeds 2000 entries')
        wheels=join(directory,'wheels');await mkdir(wheels,{mode:0o700});let bytes=0
        for(const entry of entries.filter(item=>item.name.endsWith('.whl'))){if(!entry.isFile() || entry.isSymbolicLink())throw new EnvironmentError(400,'Offline wheel files must be regular project files');const file=await workspacePath(this.workspace,`${record.wheelDirectory}/${entry.name}`,this.sensitive);bytes+=(await stat(file)).size;if(bytes>20*1024**3)throw new EnvironmentError(413,'Offline wheel staging exceeds 20 GiB');await copyFile(file,join(wheels,entry.name))}
      }
      await this.command(this.basePython,['-I','-B','-m','venv',join(directory,'venv')],record.id)
      if(record.packages.length){this.update(record.id,{state:'installing'});await this.command(record.interpreter,['-I','-B','-m','pip','--isolated','--disable-pip-version-check','install','--no-compile','--no-input','--no-cache-dir','--only-binary=:all:','--require-hashes',...(wheels?['--no-index','--find-links',wheels]:['--index-url','https://pypi.org/simple']),'-r',requirements],record.id)}
      this.update(record.id,{state:'verifying'});await this.command(record.interpreter,['-I','-B','-m','pip','--isolated','check'],record.id)
      const manifest=await this.manifest(record)
      for(const item of record.packages)if(manifest.installed[item.name]!==item.version)throw new EnvironmentError(409,`Installed version differs from lock: ${item.name}`)
      if(this.stopping || this.closing)throw new Error(this.stopping || 'Host shutting down')
      this.update(record.id,{state:'ready',...manifest,error:undefined})
    }catch(error){this.update(record.id,{state:this.closing?'interrupted':this.stopping?'canceled':'failed',error:String(error).slice(-8000)})}
  }
  async cancel(id: string): Promise<ManagedPythonEnvironment> { const record=this.get(id);if(!active.has(record.state))return record;this.stopping='Installation canceled by the owner; partial environment is not selectable';const child=this.child;if(child)this.kill(child);await this.task;return this.get(id) }
  removePartial(id: string): Promise<ManagedPythonEnvironment> {
    if(this.closing)return Promise.reject(new EnvironmentError(409,'Environment manager is closing'))
    this.selectionPending++
    const task=this.writes.then(async()=>{
      const record=this.get(id);if(record.state==='removed')return record
      if(this.task || this.child || !['failed','canceled','interrupted'].includes(record.state) || this.selection().environmentId===id)throw new EnvironmentError(409,'Only inactive failed/canceled/interrupted installations can be removed')
      try { await this.safeDirectory(id);await rm(this.directory(id),{recursive:true,force:true}) } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error }
      return this.update(id,{state:'removed'})
    });this.writes=task.catch(()=>{});void task.finally(()=>{this.selectionPending--}).catch(()=>{});return task
  }
  async selectedInterpreter(): Promise<string> { const selection=this.selection();if(!selection.environmentId)return this.basePython;const record=this.get(selection.environmentId);if(record.state!=='ready')throw new EnvironmentError(409,'Selected environment is not ready; explicitly choose another ready environment or external Python');const manifest=await this.manifest(record);if(manifest.manifestSha256!==record.manifestSha256)throw new EnvironmentError(409,'Selected environment was changed; explicitly roll back before starting a kernel');return record.interpreter }
  select(input:{operationId:string;revision:number;environmentId:string|null}): Promise<EnvironmentSelection> {
    if(this.closing)return Promise.reject(new EnvironmentError(409,'Environment manager is closing'))
    this.selectionPending++
    const task=this.writes.then(async()=>{
      if(this.task || this.child)throw new EnvironmentError(409,'Wait for the installer/verification process to finish before selecting')
      if(!input || typeof input!=='object')throw new EnvironmentError(400,'Environment selection required')
      const operation=identity(input.operationId);if(!Number.isSafeInteger(input.revision)||input.revision<1 || !(input.environmentId===null || typeof input.environmentId==='string'))throw new EnvironmentError(400,'Invalid environment selection')
      if(input.environmentId!==null)identity(input.environmentId)
      const requestHash=hash(JSON.stringify({revision:input.revision,environmentId:input.environmentId}));const previous=this.db.prepare('SELECT request_hash FROM operations WHERE id=?').get(operation)
      if(previous){if(previous.request_hash!==requestHash)throw new EnvironmentError(409,'Selection operation belongs to another request');return this.selection()}
      const current=this.selection();if(current.revision!==input.revision)throw new EnvironmentError(409,'Environment selection changed; reload before choosing')
      if(input.environmentId){const record=this.get(input.environmentId);if(record.state!=='ready')throw new EnvironmentError(409,'Only a ready environment can be selected');const manifest=await this.manifest(record);if(record.manifestSha256!==manifest.manifestSha256)throw new EnvironmentError(409,'Environment files changed; installation cannot be selected')}
      const selected={revision:current.revision+1,environmentId:input.environmentId,operationId:operation,at:new Date().toISOString()}
      this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO selection VALUES(?,?)').run(selected.revision,JSON.stringify(selected));this.db.prepare('INSERT INTO operations VALUES(?,?)').run(operation,requestHash);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
      return selected
    });this.writes=task.catch(()=>{});void task.finally(()=>{this.selectionPending--}).catch(()=>{});return task
  }
  dispose(): Promise<void> { if(this.disposing)return this.disposing;this.closing=true;if(this.child)this.kill(this.child);return this.disposing=(async()=>{await this.task?.catch(()=>{});await this.writes;await this.commandTask?.catch(()=>{});this.db.close()})() }
}
