export type PdfAttachments='provenance'|'none'
export interface PdfPublicationProfile {dpi:number;attachments?:PdfAttachments;font?:{path:string;sha256:string;licenseDeclaration:string}}
export interface ResolvedPdfPublicationProfile extends PdfPublicationProfile {attachments:PdfAttachments}
export interface PdfFontRecord {kind:'bundled'|'project';sha256:string;bytes:number;path?:string;name?:string;licenseDeclaration:string;embeddingFlags:number;subset:boolean;upstream?:string;commit?:string}
export class PublicationError extends Error {constructor(readonly status:number,message:string){super(message)}}
