/** Independent PNG scanline decoder. Samples remain in PNG network byte order.
 * Reference: W3C PNG 3, sections 7–11. Runs only inside the bounded PDF worker.
 */
const {inflateSync}=require('node:zlib');
const passes=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
function decode16(bytes){
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),type=bytes[25],channels=({0:1,2:3,4:2,6:4})[type];
 if(bytes[24]!==16||!channels)throw Error('Invalid 16-bit PNG color type');
 const stride=channels*2,total=width*height*stride;
 // Leave room for simultaneous decompressed rows, color/alpha planes and PDF
 // compression under the publication worker memory budget.
 if(total>96000000)throw Error('16-bit PNG decoded sample budget exceeds 96 MB');
 const chunks=[];let transparent;for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),name=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+length);if(name==='IDAT')chunks.push(data);if(name==='tRNS'){if(transparent||![0,2].includes(type)||length!==(type===0?2:6))throw Error('Invalid 16-bit PNG transparency');transparent=data}at+=length+12}
 const grid=bytes[28]?passes:[[0,0,1,1]];
 const dimensions=grid.map(([x,y,dx,dy])=>({x,y,dx,dy,w:Math.max(0,Math.ceil((width-x)/dx)),h:Math.max(0,Math.ceil((height-y)/dy))}));
 const expected=dimensions.reduce((sum,p)=>sum+(p.w&&p.h?p.h*(p.w*stride+1):0),0);
 const inflated=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected+1,info:true});
 const raw=inflated.buffer;if(raw.length!==expected||inflated.engine.bytesWritten!==chunks.reduce((sum,c)=>sum+c.length,0))throw Error('PNG compressed sample size is invalid');
 const samples=Buffer.alloc(total);let offset=0;
 for(const pass of dimensions){if(!pass.w||!pass.h)continue;let previous=Buffer.alloc(pass.w*stride);for(let row=0;row<pass.h;row++){
  const filter=raw[offset++];if(filter>4)throw Error('Invalid PNG scanline filter');const current=Buffer.alloc(previous.length);
  for(let index=0;index<current.length;index++){const a=index>=stride?current[index-stride]:0,b=previous[index],c=index>=stride?previous[index-stride]:0;const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);current[index]=(raw[offset++]+predictor)&255}
  for(let col=0;col<pass.w;col++)current.copy(samples,((pass.y+row*pass.dy)*width+pass.x+col*pass.dx)*stride,col*stride,(col+1)*stride);
  previous=current;
 }}
 const colors=type===0||type===4?1:3,hasAlpha=type===4||type===6||!!transparent;
 if(!hasAlpha)return {width,height,bits:16,colors,samples};
 const color=Buffer.alloc(width*height*colors*2),alpha=Buffer.alloc(width*height*2);
 for(let pixel=0;pixel<width*height;pixel++){const start=pixel*stride;samples.copy(color,pixel*colors*2,start,start+colors*2);if(type===4||type===6)samples.copy(alpha,pixel*2,start+colors*2,start+stride);else alpha.writeUInt16BE(samples.subarray(start,start+stride).equals(transparent)?0:65535,pixel*2)}
 return {width,height,bits:16,colors,samples:color,alpha};
}
module.exports={decode16};
