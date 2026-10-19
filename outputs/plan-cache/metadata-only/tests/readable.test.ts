import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { setImmediate, setTimeout } from "node:timers/promises";
import { crc32 } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import type { ReadStatement } from "../src/database/adapter.js";
import {
  exportQuery,
  exportTable,
  type SQLiteConnection,
} from "../src/index.js";

let db: Database.Database;
let directory: string;
beforeEach(async () => {
  db = new Database(":memory:");
  directory = await mkdtemp(join(tmpdir(), "exportlite-readable-"));
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,note TEXT); WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<513) INSERT INTO users SELECT x,'Jóe 雪 '||x,CASE WHEN x%3=0 THEN NULL ELSE '{\"text\":true}' END FROM n",
  );
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

async function collect(input: Readable | ReadableStream<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
// Bridge the supported Node type definitions' DOM/BYOB generic mismatch.
function asNode(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as unknown as NodeWebStream<Uint8Array>);
}
async function unzip(bytes: Buffer, name: string) {
  const archive = await fromBufferPromise(bytes);
  try {
    expect(archive.entryCount).toBe(1);
    let plain = Buffer.alloc(0);
    for await (const entry of archive.eachEntry()) {
      expect(entry.fileName).toBe(name);
      expect(entry.compressionMethod).toBe(8);
      plain = await collect(await archive.openReadStreamPromise(entry));
      expect(plain.length).toBe(entry.uncompressedSize);
      expect(crc32(plain)).toBe(entry.crc32);
    }
    return plain;
  } finally {
    archive.close();
  }
}

describe("readable exports", () => {
  it.each(
    [false, true].flatMap((zip) =>
      [false, true].flatMap((query) =>
        (["json", "jsonl"] as const).flatMap((format) =>
          [0, 513].map((count) => ({ zip, query, format, count })),
        ),
      ),
    ),
  )(
    "streams $count rows as $format (zip=$zip, query=$query)",
    async ({ count, zip, query, format }) => {
      if (count === 0) db.exec("DELETE FROM users");
      const stream = query
        ? await exportQuery(db, {
            sql: "SELECT * FROM users WHERE id>=@id ORDER BY id",
            params: { id: 0 },
            format,
            zip,
          })
        : await exportTable(db, "users", { format, zip });
      expect(stream).toBeInstanceOf(ReadableStream);
      expect("toWeb" in stream).toBe(false);
      const bytes = await collect(stream);
      const text = (
        zip
          ? await unzip(bytes, `${query ? "export" : "users"}.${format}`)
          : bytes
      ).toString("utf8");
      const decoded =
        format === "json"
          ? JSON.parse(text)
          : text
            ? text
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line))
            : [];
      expect(decoded).toEqual(
        db.prepare("SELECT * FROM users ORDER BY id").all(),
      );
      expect(await stream.result).toMatchObject({
        rowsExported: count,
        bytesWritten: bytes.length,
        durationMs: expect.any(Number),
      });
      expect(stream.locked).toBe(false);
    },
  );

  it("defaults to a JSONL readable when table options are omitted", async () => {
    const stream = await exportTable(db, "users");
    expect((await collect(stream)).toString("utf8").split("\n")).toHaveLength(
      514,
    );
    await stream.result;
  });

  it.each([false, true])(
    "keeps stats pending and cancellation active while bytes remain unread (zip=%s)",
    async (zip) => {
      const controller = new AbortController();
      const stream = await exportTable(db, "users", {
        zip,
        signal: controller.signal,
      });
      let resolved = false;
      stream.result.then(
        () => {
          resolved = true;
        },
        () => {},
      );
      const reader = stream.getReader();
      expect((await reader.read()).done).toBe(false);
      await setTimeout(20);
      expect(resolved).toBe(false);
      controller.abort();
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
      await expect(reader.read()).rejects.toHaveProperty("code", "ABORTED");
      reader.releaseLock();
    },
  );

  it("observes external cancellation before a returned stream is consumed", async () => {
    const controller = new AbortController();
    const pending = exportTable(db, "users", { signal: controller.signal });
    controller.abort();
    const stream = await pending;
    await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
    await expect(stream.getReader().read()).rejects.toHaveProperty(
      "code",
      "ABORTED",
    );
  });

  it("waits for consumption and executes the data statement only once", async () => {
    let executions = 0;
    const counts: number[] = [];
    const connection: SQLiteConnection = {
      prepare(sql) {
        const statement: ReadStatement = db.prepare(sql);
        if (sql.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...args) {
            executions++;
            for (const value of iterate(...args)) {
              counts.push(Number((value as [string, number])[1]));
              yield value;
            }
          };
        }
        return statement;
      },
    };
    const stream = await exportTable(connection, "users");
    await setImmediate();
    expect(executions).toBe(0);
    await collect(stream);
    await stream.result;
    expect(executions).toBe(1);
    expect(counts).toEqual([256, 256, 1]);
  });

  it.each([false, true])(
    "works as a Web Response body (zip=%s)",
    async (zip) => {
      const stream = await exportTable(db, "users", { format: "json", zip });
      const response = new Response(stream, {
        headers: {
          "Content-Type": zip ? "application/zip" : "application/json",
        },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const plain = zip ? await unzip(bytes, "users.json") : bytes;
      expect(JSON.parse(plain.toString("utf8"))).toEqual(
        db.prepare("SELECT * FROM users ORDER BY id").all(),
      );
      expect((await stream.result).bytesWritten).toBe(bytes.length);
    },
  );

  it("pipes into a caller's file through the Node pipeline API", async () => {
    const stream = await exportTable(db, "users", { zip: true });
    const path = join(directory, "users.zip");
    await pipeline(asNode(stream), createWriteStream(path, { flags: "wx" }));
    await unzip(await readFile(path), "users.jsonl");
    expect((await stream.result).rowsExported).toBe(513);
  });

  it.each([false, true])(
    "pauses SQL computation under downstream backpressure (zip=%s)",
    async (zip) => {
      const values = Array.from({ length: 16 }, () =>
        randomBytes(12_000).toString("base64"),
      );
      let stepped = 0;
      db.function(
        "observed",
        () => values[++stepped % values.length] as string,
      );
      const stream = await exportQuery(db, {
        sql: "SELECT observed() AS note FROM users",
        zip,
      });
      let release: (() => void) | undefined;
      let hold = true;
      const sink = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (hold) release = callback;
          else callback();
        },
      });
      const pending = pipeline(asNode(stream), sink);
      try {
        await setTimeout(60);
        const paused = stepped;
        expect(paused).toBeGreaterThan(0);
        expect(paused).toBeLessThan(513);
        await setTimeout(30);
        expect(stepped).toBe(paused);
        hold = false;
        release?.();
        release = undefined;
        await pending;
        expect((await stream.result).rowsExported).toBe(513);
      } finally {
        hold = false;
        release?.();
        await pending.catch(() => {});
      }
    },
  );

  it.each([false, true])(
    "releases SQL and ZIP resources when the destination fails (zip=%s)",
    async (zip) => {
      const stream = await exportTable(db, "users", { zip, bufferSize: 1 });
      const sink = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("client disconnected"));
        },
      });
      await expect(pipeline(asNode(stream), sink)).rejects.toThrow(
        "client disconnected",
      );
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
      db.exec("DROP TABLE users");
    },
  );

  it.each([false, true])(
    "cancels an unread stream without ever stepping SQLite (zip=%s)",
    async (zip) => {
      let stepped = 0;
      db.function("observed", () => ++stepped);
      const stream = await exportQuery(db, {
        sql: "SELECT observed() AS n FROM users",
        zip,
      });
      await stream.cancel();
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
      expect(stepped).toBe(0);
    },
  );

  it.each([false, true])(
    "cancels when an async iterator stops early (zip=%s)",
    async (zip) => {
      const stream = await exportQuery(db, {
        sql: "SELECT hex(zeroblob(4096)) AS note FROM users",
        zip,
        bufferSize: 1,
      });
      for await (const _chunk of stream) break;
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
      db.exec("DROP TABLE users");
    },
  );

  it.each([false, true])(
    "propagates AbortSignal while output is blocked (zip=%s)",
    async (zip) => {
      // Keep the export larger than the Node adapter's bounded read queue,
      // including after compression, so this abort occurs during production.
      db.exec("UPDATE users SET note=hex(randomblob(4096))");
      const controller = new AbortController();
      const stream = await exportTable(db, "users", {
        signal: controller.signal,
        zip,
        bufferSize: 1,
      });
      let release: (() => void) | undefined;
      let hold = true;
      let ready!: () => void;
      const blocked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const sink = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (hold) {
            release = callback;
            ready();
          } else callback();
        },
      });
      const pending = pipeline(asNode(stream), sink);
      const rejection = expect(pending).rejects.toHaveProperty(
        "code",
        "ABORTED",
      );
      await blocked;
      controller.abort("request disconnected");
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
      db.exec("DROP TABLE users");
      // A Web-to-Node adapter observes the error on its next read. A pending
      // caller-owned write must finish before that pipeline can advance. Any
      // adapter-buffered chunks can then finish too, without a second deadlock.
      hold = false;
      release?.();
      await rejection;
    },
  );

  it.each([false, true])(
    "honors Web writable backpressure (zip=%s)",
    async (zip) => {
      let stepped = 0;
      db.function("observed", () => {
        stepped++;
        return randomBytes(12_000).toString("base64");
      });
      const stream = await exportQuery(db, {
        sql: "SELECT observed() AS note FROM users",
        zip,
      });
      let release: (() => void) | undefined;
      let hold = true;
      const pending = stream.pipeTo(
        new WritableStream({
          async write(chunk) {
            expect(chunk).toBeInstanceOf(Uint8Array);
            if (hold)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
          },
        }),
      );
      try {
        await setTimeout(60);
        const paused = stepped;
        expect(paused).toBeGreaterThan(0);
        expect(paused).toBeLessThan(513);
        await setTimeout(30);
        expect(stepped).toBe(paused);
        hold = false;
        release?.();
        release = undefined;
        await pending;
        expect((await stream.result).rowsExported).toBe(513);
      } finally {
        hold = false;
        release?.();
        await pending.catch(() => {});
      }
    },
  );

  it.each([false, true])(
    "waits for cleanup when a Web writable fails (zip=%s)",
    async (zip) => {
      const stream = await exportQuery(db, {
        sql: "SELECT hex(zeroblob(4096)) AS note FROM users",
        zip,
        bufferSize: 1,
      });
      await expect(
        stream.pipeTo(
          new WritableStream({
            write() {
              throw new Error("download disconnected");
            },
          }),
        ),
      ).rejects.toThrow("download disconnected");
      db.exec("DROP TABLE users");
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
    },
  );

  it.each([false, true])(
    "Web cancellation stops the producer (zip=%s)",
    async (zip) => {
      const stream = await exportQuery(db, {
        sql: "SELECT hex(zeroblob(4096)) AS note FROM users",
        zip,
      });
      const response = new Response(stream);
      if (!response.body) throw new Error("Expected response body");
      const reader = response.body.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel("download cancelled");
      db.exec("DROP TABLE users");
      await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
    },
  );

  it.each([false, true])(
    "forwards SQLite failures to both the reader and stats (zip=%s)",
    async (zip) => {
      db.exec("UPDATE users SET note=x'1234' WHERE id=513");
      const stream = await exportTable(db, "users", { zip, bufferSize: 1 });
      await expect(collect(stream)).rejects.toMatchObject({
        code: "SQLITE_ERROR",
        message: expect.stringContaining("BLOB"),
      });
      await expect(stream.result).rejects.toHaveProperty(
        "code",
        "SQLITE_ERROR",
      );
    },
  );

  it("keeps validated stream options stable until reading starts", async () => {
    const options: { format: "json" | "jsonl"; zip: boolean } = {
      format: "json",
      zip: true,
    };
    const stream = await exportTable(db, "users", options);
    options.format = "jsonl";
    options.zip = false;
    const plain = await unzip(await collect(stream), "users.json");
    expect(JSON.parse(plain.toString("utf8"))).toHaveLength(513);
    await stream.result;
  });

  it("snapshots named query bindings before consumption", async () => {
    const params = { id: 1 };
    const stream = await exportQuery(db, {
      sql: "SELECT id FROM users WHERE id=@id",
      params,
      format: "json",
    });
    params.id = 513;
    expect(JSON.parse((await collect(stream)).toString("utf8"))).toEqual([
      { id: 1 },
    ]);
    await stream.result;
  });

  it("preserves fallback tables, exact integers, selected columns and transactions", async () => {
    db.exec(
      "CREATE VIEW user_view AS SELECT * FROM users; INSERT INTO users VALUES(9223372036854775807,'max',NULL); BEGIN",
    );
    db.defaultSafeIntegers(true);
    try {
      const stream = await exportTable(db, "user_view", {
        columns: ["id"],
        format: "json",
      });
      expect((await collect(stream)).toString("utf8")).toContain(
        '"id":9223372036854775807',
      );
      await stream.result;
      expect(db.inTransaction).toBe(true);
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it("validates before returning a readable", async () => {
    await expect(exportTable(db, "missing")).rejects.toHaveProperty(
      "code",
      "INVALID_SCHEMA",
    );
    await expect(
      exportQuery(db, { sql: "DELETE FROM users" }),
    ).rejects.toHaveProperty("code", "INVALID_QUERY");
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportTable(db, "users", { signal: controller.signal }),
    ).rejects.toHaveProperty("code", "ABORTED");
    await expect(
      exportTable(db, "users", { end: true } as never),
    ).rejects.toHaveProperty("code", "INVALID_OPTIONS");
    await expect(
      exportTable(db, "users", { output: null } as never),
    ).rejects.toHaveProperty("code", "INVALID_OPTIONS");
  });
});
