/** Read only the main-image TIFF orientation. Never execute/expose metadata. */
function pngExif(data){
 if(data.length<8)throw Error('Invalid PNG EXIF header');const order=data.toString('ascii',0,2);if(!['II','MM'].includes(order))throw Error('Invalid PNG EXIF byte order');const little=order==='II';const u16=offset=>little?data.readUInt16LE(offset):data.readUInt16BE(offset),u32=offset=>little?data.readUInt32LE(offset):data.readUInt32BE(offset);
 if(u16(2)!==42)throw Error('Unsupported PNG EXIF TIFF variant');const offset=u32(4);if(offset<8||offset+2>data.length)throw Error('Invalid PNG EXIF main directory');const count=u16(offset);if(count>256||offset+2+count*12+4>data.length)throw Error('Invalid PNG EXIF directory bounds');let orientation;
 for(let index=0;index<count;index++){const entry=offset+2+index*12;if(u16(entry)!==0x112)continue;if(orientation!==undefined||u16(entry+2)!==3||u32(entry+4)!==1)throw Error('Invalid PNG EXIF orientation');orientation=u16(entry+8);if(orientation!==1)throw Error('PNG EXIF requires orientation transformation; use the original SVG')}
 return {present:true,mainImageOrientation:orientation??'absent',policy:'No rotation or mirroring; other EXIF retained only in original attachment'};
}
module.exports={pngExif};
