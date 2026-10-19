import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import crc from "../src/output/crc32.js";

describe("ZIP native CRC32 adapter", () => {
  it("leaves another ZIP consumer's checksum implementation untouched", async () => {
    const require = createRequire(import.meta.url);
    const zipRequire = createRequire(require.resolve("zip-stream"));
    const legacy = createRequire(zipRequire.resolve("compress-commons"))(
      "crc-32",
    ) as { buf(bytes: Buffer): number };
    const original = legacy.buf;
    const db = new Database(":memory:");
    try {
      const { exportQuery, integer } = await import("../dist/index.mjs");
      const stream = await exportQuery(db, {
        sql: "SELECT 1 AS id",
        columns: { id: integer() },
        zip: true,
      });
      await new Response(stream).arrayBuffer();
      await stream.result;
      expect(legacy.buf).toBe(original);
      expect(legacy.buf(Buffer.from("123456789")) >>> 0).toBe(0xcbf43926);
    } finally {
      db.close();
    }
  });

  it.each([
    ["", 0x00000000],
    ["123456789", 0xcbf43926],
    ["The quick brown fox jumps over the lazy dog", 0x414fa339],
  ] as const)("matches the IEEE CRC32 vector %j", (text, expected) => {
    expect(crc.buf(Buffer.from(text)) >>> 0).toBe(expected);
  });

  it.each([0, 1, 4, 8, 9])(
    "preserves the checksum across a split at byte %i",
    (split) => {
      const bytes = Buffer.from("123456789");
      const initial = Buffer.alloc(4);
      const first = crc.buf(bytes.subarray(0, split), initial);
      const second = crc.buf(bytes.subarray(split), first);
      expect(second >>> 0).toBe(0xcbf43926);
      // The upstream library starts with a Buffer seed and then stores numbers.
      const seed = Buffer.alloc(4);
      seed.writeUInt32BE(first >>> 0);
      expect(crc.buf(bytes.subarray(split), seed)).toBe(second);
      expect(crc.buf(Buffer.alloc(0), second)).toBe(second);
    },
  );
});
