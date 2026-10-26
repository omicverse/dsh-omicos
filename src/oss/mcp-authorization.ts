import {createRequire} from 'node:module'
import type {DatabaseSync as Database} from 'node:sqlite'
import {chmod,mkdir,open} from 'node:fs/promises'
import {join} from 'node:path'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/** The current grant lives outside portable project files. Project database rollback
 * or a copied historical enabled revision cannot restore a revoked authorization. */
export class McpAuthorization {
  private closed=false
  private constructor(private db:Database){}
  static async open(stateDir:string):Promise<McpAuthorization>{
    await mkdir(stateDir,{recursive:true,mode:0o700});const path=join(stateDir,'mcp-authorization.sqlite');const file=await open(path,'a',0o600);await file.close();await chmod(path,0o600)
    const db=new DatabaseSync(path)
    try{
      const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),application=Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if(version>1||(application!==0&&application!==0x4f4d4341)||(version&&application!==0x4f4d4341))throw new Error('Unsupported private MCP authorization state; preserve it')
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if(!version){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw new Error('Unknown MCP authorization database');db.exec(`BEGIN IMMEDIATE; CREATE TABLE grants(workspace TEXT NOT NULL,id TEXT NOT NULL,digest TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(workspace,id)); PRAGMA user_version=1; PRAGMA application_id=${0x4f4d4341}; COMMIT;`)}
      return new McpAuthorization(db)
    }catch(error){db.close();throw error}
  }
  authorized(workspace:string,id:string,digest:string):boolean{return this.db.prepare('SELECT digest FROM grants WHERE workspace=? AND id=?').get(workspace,id)?.digest===digest}
  revoke(workspace:string,id:string):void{this.db.prepare('INSERT INTO grants VALUES(?,?,NULL,?) ON CONFLICT(workspace,id) DO UPDATE SET digest=NULL,updated_at=excluded.updated_at').run(workspace,id,new Date().toISOString())}
  grant(workspace:string,id:string,digest:string):void{this.db.prepare('INSERT INTO grants VALUES(?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET digest=excluded.digest,updated_at=excluded.updated_at').run(workspace,id,digest,new Date().toISOString())}
  dispose():void{if(this.closed)return;this.closed=true;this.db.close()}
}
