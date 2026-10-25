export interface DossierSource { kind:'execution'|'pipeline-execution'|'import'|'method'|'figure'|'notebook'|'plan';id:string;runId?:string }
export interface DossierPin { source:DossierSource;scope:string;data:unknown;sha256:string;capturedAt:string }
export interface DossierEntry {id:string;revision:number;title:string;finding:string;limitations:string;tags:string[];sources:DossierPin[];state:'draft'|'reviewed'|'withdrawn';author:string;createdAt:string;updatedAt:string;digest:string;lastAction:string;lastNote:string;review?:{actor:string;note:string;at:string;assessedDigest:string;checks:Array<{source:DossierSource;at:string;sha256:string}>}}
export interface DossierDraft {id?:string;revision?:number;operationId:string;title:string;finding:string;limitations:string;tags:string[];sources:DossierSource[]}
export class DossierError extends Error{constructor(readonly status:number,message:string){super(message)}}

export type DossierRevision = Pick<DossierEntry,'id'|'revision'|'title'|'state'|'digest'|'updatedAt'|'lastAction'|'lastNote'>
