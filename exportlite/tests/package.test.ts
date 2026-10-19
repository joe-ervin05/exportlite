import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";

it.each(["esm", "cjs"])(
  "decodes a ZIP from the built %s entry point",
  async (format) => {
    const built: typeof import("../src/index.js") =
      format === "esm"
        ? await import("../dist/index.mjs")
        : createRequire(import.meta.url)("../dist/index.cjs");
    const db = new Database(":memory:");
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    try {
      const result = await built.exportQuery(db, {
        sql: "SELECT ? AS name",
        params: ["雪"],
        zip: true,
        format: "json",
        output,
        end: true,
      });
      const bytes = Buffer.concat(chunks);
      expect(result.bytesWritten).toBe(bytes.length);
      expect(output.writableFinished).toBe(true);
      const archive = await fromBufferPromise(bytes);
      try {
        expect(archive.entryCount).toBe(1);
        for await (const entry of archive.eachEntry()) {
          expect(entry.fileName).toBe("export.json");
          const parts: Buffer[] = [];
          for await (const chunk of await archive.openReadStreamPromise(entry))
            parts.push(chunk);
          const text = Buffer.concat(parts);
          expect(crc32(text)).toBe(entry.crc32);
          expect(JSON.parse(text.toString("utf8"))).toEqual([{ name: "雪" }]);
        }
      } finally {
        archive.close();
      }
      const stream = await built.exportQuery(db, {
        sql: "SELECT ? AS name",
        params: ["雪"],
        format: "json",
      });
      expect(stream).toBeInstanceOf(ReadableStream);
      expect("toWeb" in stream).toBe(false);
      const response = new Response(stream);
      expect(await response.json()).toEqual([{ name: "雪" }]);
      expect((await stream.result).rowsExported).toBe(1);
      const zipped = await built.exportQuery(db, {
        sql: "SELECT 1 AS id",
        format: "json",
        zip: true,
      });
      const zippedResponse = new Response(zipped);
      const zipBytes = Buffer.from(await zippedResponse.arrayBuffer());
      const zipFile = await fromBufferPromise(zipBytes);
      try {
        expect(zipFile.entryCount).toBe(1);
      } finally {
        zipFile.close();
      }
      expect((await zipped.result).bytesWritten).toBe(zipBytes.length);
      const declared = await built.exportQuery(db, {
        sql: "SELECT 1 AS id, '雪' AS name",
        columns: {
          userId: built.integer("id").notNull(),
          displayName: built.text("name"),
        },
        format: "json",
      });
      expect(await new Response(declared).json()).toEqual([
        { userId: 1, displayName: "雪" },
      ]);
      await declared.result;
      db.exec(
        "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'雪')",
      );
      const table = await built.exportTable(db, "users", {
        columns: {
          userId: built.integer("id").primaryKey(),
          label: built.text("name"),
        },
        format: "json",
        encoding: "utf8",
      });
      expect(await new Response(table).json()).toEqual([
        { userId: 1, label: "雪" },
      ]);
      await table.result;
    } finally {
      db.close();
    }
  },
);
