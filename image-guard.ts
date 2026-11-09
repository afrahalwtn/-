// Strict, bounded image metadata parser. No decoder / native package required.
// Protects mobile browsers from tiny files declaring enormous pixel buffers.
export type ImageMime='image/jpeg'|'image/png'|'image/webp';
export interface ImageSize{width:number;height:number}
export function imageSize(bytes:Buffer,mime:ImageMime):ImageSize|null{
  if(mime==='image/png'){
    if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
       bytes.toString('ascii',12,16)!=='IHDR')return null;
    return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  }
  if(mime==='image/webp'){
    if(bytes.length<30||bytes.toString('ascii',0,4)!=='RIFF'||
       bytes.toString('ascii',8,12)!=='WEBP')return null;
    const format=bytes.toString('ascii',12,16);
    if(format==='VP8X')return {
      width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)
    };
    if(format==='VP8L'&&bytes[20]===0x2f)return {
      width:1+(bytes[21]|((bytes[22]&0x3f)<<8)),
      height:1+((bytes[22]>>6)|(bytes[23]<<2)|((bytes[24]&0x0f)<<10)),
    };
    if(format==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a)
      return {width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
    return null;
  }
  if(mime==='image/jpeg'){
    if(bytes.length<12||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
    let at=2;
    while(at+3<bytes.length){
      if(bytes[at]!==0xff)return null;
      while(at<bytes.length&&bytes[at]===0xff)at++;
      if(at>=bytes.length)return null;
      const marker=bytes[at++];
      if(marker===0xd9||marker===0xda)break; // End / compressed data reached.
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(at+2>bytes.length)return null;
      const length=bytes.readUInt16BE(at);
      if(length<2||at+length>bytes.length)return null;
      const isFrame=(marker>=0xc0&&marker<=0xcf)&&![0xc4,0xc8,0xcc].includes(marker);
      if(isFrame){
        if(length<7)return null;
        return {height:bytes.readUInt16BE(at+3),width:bytes.readUInt16BE(at+5)};
      }
      at+=length;
    }
    return null;
  }
  return null;
}
export function validProductImageDimensions(bytes:Buffer,mime:ImageMime):boolean{
  const size=imageSize(bytes,mime);
  // 40 megapixels and a 12k-pixel axis comfortably cover normal product photos.
  return Boolean(size&&Number.isSafeInteger(size.width)&&Number.isSafeInteger(size.height)&&
    size.width>0&&size.height>0&&size.width<=12000&&size.height<=12000&&
    size.width*size.height<=40_000_000);
}
