import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { openPromise } from "yauzl";

// Independent reader; verify the full decoded contents without retaining them.
export async function readZip(
  path,
  { name = "data.json", collect = false } = {},
) {
  const archive = await openPromise(path, { lazyEntries: true });
  const hash = createHash("sha256");
  const chunks = [];
  let bytes = 0;
  let checksum = 0;
  let metadata;
  try {
    assert.equal(archive.entryCount, 1);
    for await (const entry of archive.eachEntry()) {
      assert.equal(entry.fileName, name);
      assert.equal(entry.compressionMethod, 8);
      assert.equal(entry.isEncrypted(), false);
      const input = await archive.openReadStreamPromise(entry);
      for await (const chunk of input) {
        bytes += chunk.length;
        checksum = crc32(chunk, checksum);
        hash.update(chunk);
        if (collect) chunks.push(chunk);
      }
      assert.equal(bytes, entry.uncompressedSize);
      assert.equal(checksum, entry.crc32);
      metadata = {
        fileName: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        crc32: entry.crc32,
        versionNeededToExtract: entry.versionNeededToExtract,
      };
    }
    return {
      sha256: hash.digest("hex"),
      bytes,
      entry: metadata,
      ...(collect ? { text: Buffer.concat(chunks).toString("utf8") } : {}),
    };
  } finally {
    archive.close();
  }
}
