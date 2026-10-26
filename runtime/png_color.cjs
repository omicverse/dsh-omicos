/** PNG ICC/sRGB/calibrated-gamma interpretation. No network access, host lookup or sample transform. */
const {inflateSync}=require('node:zlib');
const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');const {join}=require('node:path');
let srgbProfile;function srgb(){if(!srgbProfile){const bytes=readFileSync(join(__dirname,'color-profiles','srgb-lcms216.icc'));if(createHash('sha256').update(bytes).digest('hex')!=='c792eb7d04fd81c4bb37a20f852efd02c8b8490c730f42d31b943226587c633f')throw Error('Bundled sRGB ICC checksum mismatch');srgbProfile=bytes}return srgbProfile}
// Solve primary luminances so RGB=(1,1,1) maps to the declared XYZ white.
function calibration(chroma,gray){
 const xy=chroma?Array.from({length:8},(_,i)=>chroma.readUInt32BE(i*4)/100000):[.3127,.329,.64,.33,.30,.60,.15,.06];
 for(let i=0;i<xy.length;i+=2)if(xy[i]<0||xy[i+1]<=0||xy[i]+xy[i+1]>1)throw Error('Unsupported PNG chromaticity coordinates');
 const white=[xy[0]/xy[1],1,(1-xy[0]-xy[1])/xy[1]];if(white.some(value=>!Number.isFinite(value)||value<=0||value>100))throw Error('Unsupported PNG white point');if(gray)return {white};
 const columns=[2,4,6].map(i=>[xy[i]/xy[i+1],1,(1-xy[i]-xy[i+1])/xy[i+1]]);
 const rows=[0,1,2].map(i=>[...columns.map(c=>c[i]),white[i]]);
 for(let pivot=0;pivot<3;pivot++){let best=pivot;for(let row=pivot+1;row<3;row++)if(Math.abs(rows[row][pivot])>Math.abs(rows[best][pivot]))best=row;[rows[pivot],rows[best]]=[rows[best],rows[pivot]];const factor=rows[pivot][pivot];if(Math.abs(factor)<1e-9)throw Error('Degenerate PNG primary matrix');for(let col=pivot;col<4;col++)rows[pivot][col]/=factor;for(let row=0;row<3;row++){if(row===pivot)continue;const multiple=rows[row][pivot];for(let col=pivot;col<4;col++)rows[row][col]-=multiple*rows[pivot][col]}}
 const luminance=rows.map(row=>row[3]);if(luminance.some(value=>value<=0||!Number.isFinite(value)||value>10))throw Error('Unsupported PNG primary luminance');return {white,matrix:columns.flatMap((c,i)=>c.map(value=>value*luminance[i]))};
}
function pngColor(bytes){
 const chunks=new Map();for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),name=bytes.toString('ascii',at+4,at+8);if(['iCCP','sRGB','gAMA','cHRM'].includes(name)){if(chunks.has(name))throw Error('Duplicate PNG color declaration');chunks.set(name,bytes.subarray(at+8,at+8+length))}at+=length+12}
 const gamma=chunks.get('gAMA'),chroma=chunks.get('cHRM');if(gamma&&(gamma.length!==4||gamma.readUInt32BE(0)===0))throw Error('Invalid PNG gamma');if(chroma&&chroma.length!==32)throw Error('Invalid PNG chromaticities');
 const embedded=chunks.get('iCCP');const standard=chunks.get('sRGB');if(!embedded&&standard){if(standard.length!==1||standard[0]>3)throw Error('Invalid PNG sRGB rendering intent');const profile=srgb();return {profile,colors:3,expandGray:[0,4].includes(bytes[25]),metadata:{kind:'srgb',sha256:createHash('sha256').update(profile).digest('hex'),bytes:profile.length,channels:3,renderingIntent:standard[0],ignoredFallbackChunks:[...chunks.keys()].filter(key=>key!=='sRGB')}}}if(!embedded){if(gamma){const exponent=100000/gamma.readUInt32BE(0);if(exponent<.1||exponent>10)throw Error('PNG gamma is outside the supported calibrated range');const gray=[0,4].includes(bytes[25]),values=calibration(chroma,gray);return {calibrated:{...values,gamma:exponent,gray},metadata:{kind:gray?'calibrated-gray':'calibrated-rgb',gammaEncoding:gamma.readUInt32BE(0)/100000,decodingExponent:exponent,whitePoint:values.white,matrix:values.matrix,chromaticities:chroma?'source-cHRM':'assumed-sRGB-D65-missing-cHRM',assumptions:chroma?[]:['Missing cHRM: use sRGB primaries and D65 white point; source primaries are not known']}}}if(chunks.size)throw Error('PNG chromaticities without gamma need a supported transfer declaration');return {metadata:{kind:'unmanaged'}}}
 if(chunks.has('sRGB'))throw Error('PNG cannot contain both iCCP and sRGB');
 const separator=embedded.indexOf(0);if(separator<1||separator>79||embedded[separator+1]!==0||separator+2>=embedded.length)throw Error('Invalid PNG ICC name/compression');
 const name=embedded.subarray(0,separator);if([...name].some(byte=>byte<32||(byte>126&&byte<161))||name[0]===32||name[name.length-1]===32||name.includes(Buffer.from('  ')))throw Error('Invalid PNG ICC profile name');
 const compressed=embedded.subarray(separator+2);const inflated=inflateSync(compressed,{maxOutputLength:4000000,info:true});const profile=inflated.buffer;
 if(inflated.engine.bytesWritten!==compressed.length||profile.length<132||profile.readUInt32BE(0)!==profile.length||profile.toString('ascii',36,40)!=='acsp'||![2,4].includes(profile[8])||!['XYZ ','Lab '].includes(profile.toString('ascii',20,24))||!['scnr','mntr','prtr','spac'].includes(profile.toString('ascii',12,16))||profile.readUInt32BE(64)>3)throw Error('Unsupported or invalid PNG ICC header');
 const type=bytes[25],colors=[0,4].includes(type)?1:3;if(profile.toString('ascii',16,20)!==(colors===1?'GRAY':'RGB '))throw Error('PNG ICC color channels disagree with PNG color type');
 const count=profile.readUInt32BE(128);if(!count||count>256||132+count*12>profile.length)throw Error('Invalid ICC tag table');const seen=new Set(),ranges=[];
 for(let index=0;index<count;index++){const base=132+index*12,tag=profile.toString('ascii',base,base+4),offset=profile.readUInt32BE(base+4),length=profile.readUInt32BE(base+8);if(seen.has(tag)||offset%4||offset<132+count*12||length<8||offset+length>profile.length)throw Error('Invalid ICC tag bounds');if(ranges.some(([start,end])=>offset<end&&offset+length>start&&(offset!==start||offset+length!==end)))throw Error('Overlapping ICC tag ranges');ranges.push([offset,offset+length]);seen.add(tag)}
 // Preserve the exact profile bytes. These structural checks are deliberately
 // not a certification of ICC correctness or a promise of identical displays.
 return {profile,colors,metadata:{kind:'embedded-icc',name:name.toString('latin1'),sha256:createHash('sha256').update(profile).digest('hex'),bytes:profile.length,channels:colors,versionMajor:profile[8],renderingIntent:profile.readUInt32BE(64),ignoredFallbackChunks:[...chunks.keys()].filter(key=>key!=='iCCP')}};
}
module.exports={pngColor};
