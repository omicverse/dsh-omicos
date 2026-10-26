import type {FigureVersion} from './figure-types.js'
export interface AssemblyPanel {figureId:string;figureRevision:number;x:number;y:number;width:number;height:number;label:string}
export interface AssemblyLayout {width:number;height:number;panels:AssemblyPanel[]}
export interface AssemblyDraft {id?:string;revision?:number;operationId:string;title:string;caption:string;layout:AssemblyLayout}
export interface AssemblyVersion {id:string;revision:number;title:string;caption:string;layout:AssemblyLayout;sources:Array<{figure:FigureVersion;width:number;height:number}>;createdAt:string;updatedAt:string;author:string;digest:string;review:{state:'draft'|'approved'|'changes-requested'|'withdrawn';note?:string;at?:string;assessedDigest?:string}}
export class AssemblyError extends Error {constructor(readonly status:number,message:string){super(message)}}
