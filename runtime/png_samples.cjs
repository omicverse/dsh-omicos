/** Independent PNG scanline decoder. Samples remain in PNG network byte order.
 * Reference: W3C PNG 3, sections 7–11. Runs only inside the bounded PDF worker.
 */
const {inflateSync}=require('node:zlib');
const passes=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
function decodeSamples(bytes){
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),type=bytes[25],bits=bytes[24],channels=({0:1,2:3,3:1,4:2,6:4})[type];
 if(!channels||![1,2,4,8,16].includes(bits))throw Error('Invalid PNG color type');
 const sampleBytes=bits===16?2:1,stride=Math.max(1,Math.ceil(channels*bits/8)),total=width*height*channels*sampleBytes;
 // Leave room for simultaneous decompressed rows, color/alpha planes and PDF
 // compression under the publication worker memory budget.
 if(total>96000000)throw Error('PNG decoded sample budget exceeds 96 MB');
 const chunks=[];let transparent,palette;for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),name=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+length);if(name==='IDAT')chunks.push(data);if(name==='PLTE')palette=data;if(name==='tRNS'){if(transparent||![0,2,3].includes(type)||(type!==3&&length!==(type===0?2:6))||(type===3&&(!palette||length>palette.length/3||!length)))throw Error('Invalid PNG transparency');transparent=data}at+=length+12}
 const grid=bytes[28]?passes:[[0,0,1,1]];
 const dimensions=grid.map(([x,y,dx,dy])=>({x,y,dx,dy,w:Math.max(0,Math.ceil((width-x)/dx)),h:Math.max(0,Math.ceil((height-y)/dy))}));
 const expected=dimensions.reduce((sum,p)=>sum+(p.w&&p.h?p.h*(Math.ceil(p.w*channels*bits/8)+1):0),0);
 const inflated=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected+1,info:true});
 const raw=inflated.buffer;if(raw.length!==expected||inflated.engine.bytesWritten!==chunks.reduce((sum,c)=>sum+c.length,0))throw Error('PNG compressed sample size is invalid');
 const samples=Buffer.alloc(total);let offset=0;
 for(const pass of dimensions){if(!pass.w||!pass.h)continue;let previous=Buffer.alloc(Math.ceil(pass.w*channels*bits/8));for(let row=0;row<pass.h;row++){
  const filter=raw[offset++];if(filter>4)throw Error('Invalid PNG scanline filter');const current=Buffer.alloc(previous.length);
  for(let index=0;index<current.length;index++){const a=index>=stride?current[index-stride]:0,b=previous[index],c=index>=stride?previous[index-stride]:0;const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);current[index]=(raw[offset++]+predictor)&255}
  for(let col=0;col<pass.w;col++){const target=((pass.y+row*pass.dy)*width+pass.x+col*pass.dx)*channels*sampleBytes;if(bits>=8)current.copy(samples,target,col*channels*sampleBytes,(col+1)*channels*sampleBytes);else samples[target]=(current[Math.floor(col*bits/8)]>>>(8-bits-(col*bits%8)))&((1<<bits)-1)}
  previous=current;
 }}
 const colors=type===0||type===4?1:3,hasAlpha=type===4||type===6||!!transparent;
 if(width*height*(colors+(hasAlpha?1:0))*sampleBytes>96000000)throw Error('PNG decoded sample budget exceeds 96 MB');
 const color=Buffer.alloc(width*height*colors*sampleBytes),alpha=hasAlpha?Buffer.alloc(width*height*sampleBytes):undefined;
 if(type===3&&(!palette||palette.length/3>2**bits))throw Error('Invalid PNG palette');
 for(let pixel=0;pixel<width*height;pixel++){
  const start=pixel*channels*sampleBytes;
  if(type===3){const index=samples[start];if(index>=palette.length/3)throw Error('PNG palette index is out of bounds');palette.copy(color,pixel*3,index*3,index*3+3);if(alpha)alpha[pixel]=index<transparent.length?transparent[index]:255;continue}
  if(bits<8)color[pixel]=Math.round(samples[start]*255/((1<<bits)-1));else samples.copy(color,pixel*colors*sampleBytes,start,start+colors*sampleBytes);
  if(!alpha)continue;
  if(type===4||type===6)samples.copy(alpha,pixel*sampleBytes,start+colors*sampleBytes,start+channels*sampleBytes);
  else {let match=true;for(let channel=0;channel<colors;channel++){const value=bits===16?samples.readUInt16BE(start+channel*2):samples[start+channel];const key=transparent.readUInt16BE(channel*2);if(key>2**bits-1)throw Error('PNG transparency key exceeds sample precision');if(value!==key)match=false}if(bits===16)alpha.writeUInt16BE(match?0:65535,pixel*2);else alpha[pixel]=match?0:255}
 }
 return {width,height,bits:bits===16?16:8,colors,samples:color,alpha};
}
module.exports={decodeSamples};
