import type {ResolvedPdfPublicationProfile} from './publication-types.js'
export interface PublicationProfileVersion {
 id:string;revision:number;name:string;description:string;profile:ResolvedPdfPublicationProfile;archived:boolean;createdAt:string;updatedAt:string;author:string;digest:string
}
export interface PublicationProfileDraft {id?:string;revision?:number;name:string;description:string;profile:ResolvedPdfPublicationProfile;archived?:boolean;operationId:string}
export interface PublicationProfilePage {entries:Array<Pick<PublicationProfileVersion,'id'|'revision'|'name'|'description'|'archived'|'updatedAt'> & {dpi:number;attachments:'provenance'|'none'}>;next?:number}
export interface PublicationProfileHistory {revisions:Array<Pick<PublicationProfileVersion,'id'|'revision'|'name'|'archived'|'updatedAt'>>;next?:number}

export interface PublicationProfileReference {id:string;revision:number;digest:string}
