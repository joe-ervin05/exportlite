import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setImmediate, setTimeout } from "node:timers/promises";
import { crc32 } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBufferPromise } from "yauzl";
import ZipStream from "zip-stream";
import type { ReadStatement } from "../src/database/adapter.js";
import {
  exportQuery,
  exportTable,
  type SQLiteConnection,
} from "../src/index.js";
import { OutputWriter } from "../src/output/writer.js";

async function decode(bytes: Buffer, name: string) {
  const archive = await fromBufferPromise(bytes, { lazyEntries: true });
  try {
    expect(archive.entryCount).toBe(1);
    let text = "";
    for await (const entry of archive.eachEntry()) {
      expect(entry.fileName).toBe(name);
      expect(entry.isEncrypted()).toBe(false);
      expect(entry.compressionMethod).toBe(8);
      const chunks: Buffer[] = [];
      const input = await archive.openReadStreamPromise(entry);
      for await (const chunk of input) chunks.push(chunk);
      const plain = Buffer.concat(chunks);
      expect(plain.length).toBe(entry.uncompressedSize);
      expect(crc32(plain)).toBe(entry.crc32);
      text = plain.toString("utf8");
    }
    // ZIP64 end records are emitted even for small archives.
    expect(bytes.includes(Buffer.from("504b0606", "hex"))).toBe(true);
    return text;
  } finally {
    archive.close();
  }
}
function capture(delay = false) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (delay) setImmediate().then(() => callback());
      else callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}
let db: Database.Database;
let directory: string;
function seed(count: number) {
  db.exec("DELETE FROM users");
  const insert = db.prepare("INSERT INTO users VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let id = 1; id <= count; id++)
      insert.run(id, `Jóe 雪 "${id}"\nline`, id % 3 ? '{"text":true}' : null);
  })();
}
beforeEach(async () => {
  db = new Database(":memory:");
  directory = await mkdtemp(join(tmpdir(), "exportlite-zip-"));
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
  seed(513);
});
afterEach(async () => {
  db.close(); // also catches leaked SQLite iterators
  await rm(directory, { recursive: true, force: true });
});

describe("streaming ZIP", () => {
  it("preserves an initialization failure and attempts all owned cleanup", async () => {
    const original = new Error("Injected ZIP initialization failure");
    const entry = vi
      .spyOn(ZipStream.prototype, "entry")
      .mockImplementation(() => {
        throw original;
      });
    const dispose = OutputWriter.prototype.dispose;
    const cleanup = vi
      .spyOn(OutputWriter.prototype, "dispose")
      .mockImplementation(async function (this: OutputWriter, success) {
        await dispose.call(this, success);
        throw new Error("Injected cleanup failure");
      });
    try {
      await expect(
        exportTable(db, "users", {
          output: join(directory, "failed.zip"),
          zip: true,
        }),
      ).rejects.toMatchObject({ code: "OUTPUT_ERROR", cause: original });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      entry.mockRestore();
      cleanup.mockRestore();
    }
  });

  it.each(
    [0, 1, 256, 257, 513].flatMap((count) =>
      (["json", "jsonl"] as const).flatMap((format) =>
        [false, true].map((query) => ({ count, format, query })),
      ),
    ),
  )(
    "exports $count $format rows (query=$query)",
    async ({ count, format, query }) => {
      seed(count);
      const output = capture();
      const options = { output: output.stream, format, zip: true };
      const result = query
        ? await exportQuery(db, {
            ...options,
            sql: "SELECT * FROM users WHERE id>=@id ORDER BY id",
            params: { id: 0 },
          })
        : await exportTable(db, "users", options);
      const text = await decode(
        output.bytes(),
        `${query ? "export" : "users"}.${format}`,
      );
      const rows =
        format === "json"
          ? JSON.parse(text)
          : text
            ? text
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line))
            : [];
      expect(rows).toEqual(db.prepare("SELECT * FROM users ORDER BY id").all());
      expect(result.rowsExported).toBe(count);
      expect(result.bytesWritten).toBe(output.bytes().length);
      expect(output.stream.writableLength).toBe(0);
      expect(output.stream.writableEnded).toBe(false);
      expect(output.stream.listenerCount("error")).toBe(0);
      expect(output.stream.listenerCount("drain")).toBe(0);
      output.stream.end();
    },
  );

  it("keeps one export statement and fixed 256-row batches", async () => {
    const counts: number[] = [];
    let executions = 0;
    const connection: SQLiteConnection = {
      prepare(sql) {
        const statement: ReadStatement = db.prepare(sql);
        if (sql.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...params) {
            executions++;
            for (const value of iterate(...params)) {
              counts.push(Number((value as [string, number])[1]));
              yield value;
            }
          };
        }
        return statement;
      },
    };
    await exportTable(connection, "users", {
      output: capture().stream,
      zip: true,
    });
    expect(executions).toBe(1);
    expect(counts).toEqual([256, 256, 1]);
  });

  it.each(["view", "without_rowid", "shadowed", "virtual"])(
    "preserves the %s fallback",
    async (kind) => {
      const definitions: Record<string, string> = {
        view: "CREATE VIEW fallback AS SELECT id,name,note FROM users",
        without_rowid:
          "CREATE TABLE fallback(id INTEGER PRIMARY KEY,name,note) WITHOUT ROWID; INSERT INTO fallback SELECT * FROM users",
        shadowed:
          "CREATE TABLE fallback(rowid,_rowid_,oid); INSERT INTO fallback SELECT * FROM users",
        virtual:
          "CREATE VIRTUAL TABLE fallback USING fts5(name,note); INSERT INTO fallback SELECT name,note FROM users",
      };
      db.exec(definitions[kind] as string);
      const output = capture();
      await exportTable(db, "fallback", {
        zip: true,
        format: "json",
        output: output.stream,
      });
      expect(JSON.parse(await decode(output.bytes(), "fallback.json"))).toEqual(
        db.prepare("SELECT * FROM fallback").all(),
      );
    },
  );

  it("preserves exact signed 64-bit literals and caller transactions", async () => {
    db.exec("INSERT INTO users VALUES(9223372036854775807,'max',NULL); BEGIN");
    db.defaultSafeIntegers(true);
    const output = capture();
    try {
      await exportTable(db, "users", {
        zip: true,
        format: "json",
        columns: ["id"],
        output: output.stream,
      });
      expect(await decode(output.bytes(), "users.json")).toContain(
        '"id":9223372036854775807',
      );
      expect(db.inTransaction).toBe(true);
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it.each([
    ["../雪\\users", "___雪_users.jsonl"],
    ["CON", "_CON.jsonl"],
  ])("sanitizes the entry name %s", async (table, name) => {
    db.exec(`CREATE TABLE "${table}"(id); INSERT INTO "${table}" VALUES(1)`);
    const output = capture();
    await exportTable(db, table as string, {
      output: output.stream,
      zip: true,
    });
    expect(await decode(output.bytes(), name as string)).toBe('{"id":1}\n');
  });

  it("creates complete files exclusively and counts archive bytes", async () => {
    const path = join(directory, "users.zip");
    const result = await exportTable(db, "users", { output: path, zip: true });
    const bytes = await readFile(path);
    expect(result.bytesWritten).toBe(bytes.length);
    await decode(bytes, "users.jsonl");
    await expect(
      exportTable(db, "users", { output: path, zip: true }),
    ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
    expect(await readFile(path)).toEqual(bytes);
  });

  it("awaits asynchronous writes and destination finalization", async () => {
    const output = capture(true);
    await exportTable(db, "users", {
      output: output.stream,
      zip: true,
      end: true,
    });
    expect(output.stream.writableFinished).toBe(true);
    expect(output.stream.writableLength).toBe(0);
    await decode(output.bytes(), "users.jsonl");
  });

  it.each(["write", "final", "close"])(
    "propagates %s failures",
    async (kind) => {
      const output = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (kind === "close") setImmediate().then(() => output.destroy());
          else
            setImmediate().then(() =>
              callback(kind === "write" ? new Error("disk full") : undefined),
            );
        },
        final(callback) {
          callback(new Error("final failed"));
        },
      });
      await expect(
        exportTable(db, "users", { output, zip: true, end: true }),
      ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
    },
  );

  it("propagates errors while writing the archive footer", async () => {
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const footer =
          chunk.length >= 4 && chunk.readUInt32LE(0) === 0x06054b50;
        callback(footer ? new Error("footer failed") : undefined);
      },
    });
    await expect(
      exportTable(db, "users", { output, zip: true }),
    ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
  });

  it("wraps archive finalization failures and removes the partial file", async () => {
    const finalize = vi
      .spyOn(ZipStream.prototype, "finalize")
      .mockImplementation(function (this: ZipStream) {
        this.destroy(new Error("archive failed"));
      });
    try {
      await expect(
        exportTable(db, "users", {
          zip: true,
          output: join(directory, "partial.zip"),
        }),
      ).rejects.toMatchObject({
        name: "ExportLiteError",
        code: "OUTPUT_ERROR",
        cause: expect.objectContaining({ message: "archive failed" }),
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      finalize.mockRestore();
    }
  });

  it("cancels blocked compression, releases the query, and preserves stream ownership", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const pending = exportTable(db, "users", {
      output,
      zip: true,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toHaveProperty("code", "ABORTED");
    await setImmediate();
    expect(release).toBeTypeOf("function");
    controller.abort();
    await assertion;
    expect(output.destroyed).toBe(false);
    expect(output.writableEnded).toBe(false);
    release?.();
    output.end();
    expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(513);
  });

  it("cancels while waiting for caller finalization", async () => {
    const controller = new AbortController();
    let finalize: (() => void) | undefined;
    let reachedFinal: (() => void) | undefined;
    const finalReached = new Promise<void>((resolve) => {
      reachedFinal = resolve;
    });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        finalize = callback;
        reachedFinal?.();
      },
    });
    const pending = exportTable(db, "users", {
      output,
      zip: true,
      end: true,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toHaveProperty("code", "ABORTED");
    await finalReached;
    controller.abort();
    await assertion;
    finalize?.();
  });

  it("stops pulling data once compression buffers fill under backpressure", async () => {
    const payloads = Array.from({ length: 16 }, () =>
      randomBytes(12_000).toString("base64"),
    );
    let stepped = 0;
    db.function("observed", () => {
      stepped++;
      return payloads[stepped % payloads.length] as string;
    });
    let release: (() => void) | undefined;
    let hold = true;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        if (hold) release = callback;
        else callback();
      },
    });
    const pending = exportQuery(db, {
      sql: "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT observed() AS note FROM n",
      output,
      zip: true,
    });
    try {
      await setTimeout(40);
      const paused = stepped;
      expect(paused).toBeGreaterThan(0);
      expect(paused).toBeLessThan(500);
      await setTimeout(30);
      expect(stepped).toBe(paused);
      hold = false;
      release?.();
      release = undefined;
      await expect(pending).resolves.toHaveProperty("rowsExported", 500);
    } finally {
      hold = false;
      release?.();
      await pending.catch(() => {});
    }
  });

  it("cleans partial ZIP files after SQLite errors and cancellation", async () => {
    db.exec("UPDATE users SET note=x'1234' WHERE id=513");
    await expect(
      exportTable(db, "users", {
        output: join(directory, "partial.zip"),
        zip: true,
        bufferSize: 1,
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      message: expect.stringContaining("BLOB"),
    });
    const controller = new AbortController();
    db.function("cancel", () => {
      controller.abort();
      return 1;
    });
    await expect(
      exportQuery(db, {
        sql: "SELECT cancel() AS n",
        output: join(directory, "cancel.zip"),
        zip: true,
        signal: controller.signal,
      }),
    ).rejects.toHaveProperty("code", "ABORTED");
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects invalid inputs before creating output", async () => {
    const output = join(directory, "invalid.zip");
    await expect(
      exportTable(db, "users", { output, zip: "true" as unknown as boolean }),
    ).rejects.toHaveProperty("code", "INVALID_OPTIONS");
    await expect(
      exportQuery(db, { sql: "DELETE FROM users", output, zip: true }),
    ).rejects.toBeInstanceOf(Error);
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportTable(db, "users", {
        output,
        zip: true,
        signal: controller.signal,
      }),
    ).rejects.toHaveProperty("code", "ABORTED");
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps a WAL snapshot across compression waits", async () => {
    const path = join(directory, "snapshot.sqlite");
    const writer = new Database(path);
    writer.pragma("journal_mode=WAL");
    writer.exec(
      "CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000) INSERT INTO entries SELECT x,'old-'||x FROM n",
    );
    const reader = new Database(path, { readonly: true });
    const expected = writer.prepare("SELECT * FROM entries ORDER BY id").all();
    const output = capture();
    let updated = false;
    const pending = exportTable(reader, "entries", {
      zip: true,
      format: "json",
      output: output.stream,
      bufferSize: 1,
    });
    try {
      await setImmediate();
      writer.exec(
        "UPDATE entries SET value='new' WHERE id=4500; INSERT INTO entries VALUES(5001,'added')",
      );
      updated = true;
      await expect(pending).resolves.toHaveProperty("rowsExported", 5000);
      expect(JSON.parse(await decode(output.bytes(), "entries.json"))).toEqual(
        expected,
      );
      expect(updated).toBe(true);
    } finally {
      await pending.catch(() => {});
      reader.close();
      writer.close();
    }
  });
});
