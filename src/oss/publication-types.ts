export interface PdfPublicationProfile {dpi:number;font?:{path:string;sha256:string;licenseDeclaration:string}}
export interface PdfFontRecord {kind:'bundled'|'project';sha256:string;bytes:number;path?:string;name?:string;licenseDeclaration:string;embeddingFlags:number;subset:boolean;upstream?:string;commit?:string}
export class PublicationError extends Error {constructor(readonly status:number,message:string){super(message)}}
