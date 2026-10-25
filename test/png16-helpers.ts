import {deflateSync} from 'node:zlib'
export function pngChunk(name:string,data:Buffer){const part=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const byte of part){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);part.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,data.length+8);return result}
// Test encoder deliberately uses independent coordinate enumeration/predictor
// selection; output samples are compared against the literal original array.
export function png16(width:number,height:number,type:number,samples:Buffer,interlaced=false,transparency?:Buffer){
 const channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[type],stride=channels*2;const rows:Buffer[]=[];let filterIndex=0
 const passes=interlaced?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]]
 for(const [sx,sy,dx,dy] of passes){let above:Buffer|undefined;for(let y=sy;y<height;y+=dy){const pixels:Buffer[]=[];for(let x=sx;x<width;x+=dx)pixels.push(samples.subarray((y*width+x)*stride,(y*width+x+1)*stride));if(!pixels.length)continue;const row=Buffer.concat(pixels),filter=filterIndex++%5,encoded=Buffer.alloc(row.length+1);encoded[0]=filter;for(let i=0;i<row.length;i++){const left=i>=stride?row[i-stride]:0,up=above?.[i]??0,diagonal=i>=stride?(above?.[i-stride]??0):0;let prediction=0;if(filter===1)prediction=left;if(filter===2)prediction=up;if(filter===3)prediction=Math.floor((left+up)/2);if(filter===4){const p=left+up-diagonal;prediction=[left,up,diagonal].reduce((best,value)=>Math.abs(p-value)<Math.abs(p-best)?value:best)}encoded[i+1]=(row[i]-prediction+256)%256}rows.push(encoded);above=row}}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=16;header[9]=type;header[12]=interlaced?1:0
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),...(transparency?[pngChunk('tRNS',transparency)]:[]),pngChunk('IDAT',deflateSync(Buffer.concat(rows))),pngChunk('IEND',Buffer.alloc(0))])
}
