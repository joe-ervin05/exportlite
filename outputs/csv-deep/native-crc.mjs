// Experiment only: patch this worker's checksum module to quantify the native
// CRC opportunity. Never imported by the package and not proposed for shipping.
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
const packageRequire=createRequire(new URL('../../exportlite/package.json',import.meta.url));
const require=createRequire(packageRequire.resolve('zip-stream'));
const compress=createRequire(require.resolve('compress-commons'));
const stream=createRequire(compress.resolve('crc32-stream'));
const crc=stream('crc-32');
const old=crc.buf;
crc.buf=(bytes,seed)=>crc32(bytes,Buffer.isBuffer(seed)?seed.readUInt32BE(0):seed??0)|0;
for(const bytes of [Buffer.from('123456789'),Buffer.from([0,1,255]),Buffer.alloc(100000,37)]) {
 for(const seed of [0,0xffffffff,0x12345678])if(old(bytes,seed)!==crc.buf(bytes,seed))throw Error('CRC mismatch');
}
