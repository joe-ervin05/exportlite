import { crc32 } from "node:zlib";

// Build-time replacement for the crc-32.buf API used by the bundled ZIP writer.
// crc32-stream initializes its seed as a four-byte, big-endian Buffer and uses
// numeric seeds thereafter. Keep the signed return convention of crc-32.buf.
export default {
  buf(bytes: Uint8Array, seed: number | Buffer = 0): number {
    const value = Buffer.isBuffer(seed) ? seed.readUInt32BE(0) : seed >>> 0;
    return crc32(bytes, value) | 0;
  },
};
