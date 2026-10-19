import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadStatement } from "../src/database/adapter.js";
import {
  exportQuery,
  exportTable,
  type SQLiteConnection,
} from "../src/index.js";
import { planTable } from "../src/planner/json.js";

let db: Database.Database;
let directory: string;
function seed(count: number) {
  db.exec("DELETE FROM users");
  const insert = db.prepare("INSERT INTO users VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= count; i++)
      insert.run(
        i * 3,
        `User "${i}" 雪\nline`,
        i % 3 === 0 ? null : '{"stored":true}',
      );
  })();
}
beforeEach(async () => {
  db = new Database(":memory:");
  directory = await mkdtemp(join(tmpdir(), "exportlite-v0-test-"));
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
  seed(513);
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function capture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}
function decode(text: string, format: "json" | "jsonl") {
  return format === "json"
    ? JSON.parse(text)
    : text
      ? text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
}

describe("fixed internal SQLite batches", () => {
  it("returns UTF-8 bytes from SQLite without mutating its batch buffers", async () => {
    const statement = planTable(db, "users", undefined, "json").statement;
    const iterator = statement.raw().iterate();
    const value = iterator.next().value as [Buffer, number];
    iterator.return?.();
    expect(Buffer.isBuffer(value[0])).toBe(true);
    expect(JSON.parse(value[0].toString("utf8"))).toHaveLength(256);
    const first = Buffer.from(value[0]);
    const connection: SQLiteConnection = {
      prepare(sql) {
        const prepared: ReadStatement = db.prepare(sql);
        if (sql.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
          prepared.iterate = function* () {
            yield value;
          };
        }
        return prepared;
      },
    };
    const stream = await exportTable(connection, "users", { format: "json" });
    expect(await new Response(stream).text()).toBe(first.toString("utf8"));
    expect((await stream.result).rowsExported).toBe(256);
    expect(value[0]).toEqual(first);
  });

  it.each(
    ["UTF-16le", "UTF-16be"].flatMap((encoding) =>
      (["json", "jsonl"] as const).flatMap((format) =>
        [false, true].map((zip) => ({ encoding, format, zip })),
      ),
    ),
  )(
    "preserves UTF-8 output for a $encoding database, $format, zip=$zip",
    async ({ encoding, format, zip }) => {
      const utf16 = new Database(":memory:");
      try {
        utf16.pragma(`encoding='${encoding}'`);
        utf16.exec("CREATE TABLE words(id INTEGER PRIMARY KEY, text TEXT)");
        const insert = utf16.prepare("INSERT INTO words VALUES(?, ?)");
        const records = Array.from({ length: 257 }, (_, i) => ({
          id: i + 1,
          text: `雪 café 🦦 \\"${i}\\"\n`,
        }));
        utf16.transaction(() => {
          for (const record of records) insert.run(record.id, record.text);
        })();
        const planned = planTable(utf16, "words", undefined, format);
        expect(planned.batched).toBe(true);
        const iterator = planned.statement.raw().iterate();
        expect(typeof (iterator.next().value as [string, number])[0]).toBe(
          "string",
        );
        iterator.return?.();
        const stream = await exportTable(utf16, "words", { format, zip });
        const bytes = Buffer.from(await new Response(stream).arrayBuffer());
        expect((await stream.result).rowsExported).toBe(257);
        if (zip) {
          const { fromBufferPromise } = await import("yauzl");
          const archive = await fromBufferPromise(bytes);
          try {
            for await (const entry of archive.eachEntry()) {
              const parts: Buffer[] = [];
              for await (const chunk of await archive.openReadStreamPromise(
                entry,
              ))
                parts.push(chunk);
              expect(
                decode(Buffer.concat(parts).toString("utf8"), format),
              ).toEqual(records);
            }
          } finally {
            archive.close();
          }
        } else expect(decode(bytes.toString("utf8"), format)).toEqual(records);
      } finally {
        utf16.close();
      }
    },
  );

  it.each(
    [0, 1, 255, 256, 257, 512, 513].flatMap((count) =>
      (["json", "jsonl"] as const).map((format) => ({ count, format })),
    ),
  )(
    "preserves $count rows across $format batch boundaries",
    async ({ count, format }) => {
      seed(count);
      const output = capture();
      const result = await exportTable(db, "users", {
        output: output.stream,
        format,
      });
      expect(decode(output.text(), format)).toEqual(
        db.prepare("SELECT * FROM users ORDER BY rowid").all(),
      );
      expect(result.rowsExported).toBe(count);
      expect(result.bytesWritten).toBe(Buffer.byteLength(output.text()));
      expect(output.stream.writableEnded).toBe(false);
      expect(output.stream.listenerCount("error")).toBe(0);
    },
  );

  it("executes one data statement with 256/256/1 rows through a prepare-only connection", async () => {
    const queries: string[] = [];
    const counts: number[] = [];
    let executions = 0;
    const connection: SQLiteConnection = {
      prepare(sql) {
        queries.push(sql);
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
    const output = capture();
    await exportTable(connection, "users", { output: output.stream });
    expect(counts).toEqual([256, 256, 1]);
    expect(executions).toBe(1);
    expect(queries.filter((sql) => sql.includes('main."users"'))).toHaveLength(
      1,
    );
  });

  it("preserves extreme 64-bit rowids across batches on a BigInt-configured connection", async () => {
    db.exec(
      "INSERT INTO users VALUES(-9223372036854775808,'min',NULL),(9223372036854775807,'max',NULL)",
    );
    db.defaultSafeIntegers(true);
    const output = capture();
    const result = await exportTable(db, "users", {
      columns: ["id"],
      format: "json",
      output: output.stream,
    });
    const expected = db
      .prepare(
        "SELECT json_group_array(json_object('id',id)) FROM (SELECT id FROM users ORDER BY rowid)",
      )
      .pluck()
      .get();
    expect(output.text()).toBe(expected);
    expect(output.text()).toContain("-9223372036854775808");
    expect(output.text()).toContain("9223372036854775807");
    expect(result.rowsExported).toBe(515);
    expect(db.prepare("SELECT 1").pluck().get()).toBe(1n);
  });

  it("uses an unshadowed rowid alias and respects explicit generated columns", async () => {
    db.exec(
      'CREATE TABLE "odd""table" ("rowid" TEXT, "a\'b" INTEGER, doubled GENERATED ALWAYS AS ("a\'b" * 2)); INSERT INTO "odd""table" (rowid,"a\'b") VALUES (\'text\',3),(\'other\',4)',
    );
    const output = capture();
    await exportTable(db, 'odd"table', {
      columns: ["rowid", "a'b", "doubled"],
      format: "json",
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual([
      { rowid: "text", "a'b": 3, doubled: 6 },
      { rowid: "other", "a'b": 4, doubled: 8 },
    ]);
  });

  it.each(["json", "jsonl"] as const)(
    "keeps sparse integer bounds exact at full and partial %s batch ends",
    async (format) => {
      db.exec("DELETE FROM users");
      const insert = db.prepare("INSERT INTO users VALUES (?, 'edge', NULL)");
      const ids = Array.from(
        { length: 512 },
        (_, i) => -9223372036854775808n + BigInt(i) * 9007199254740993n,
      );
      ids[255] = -9007199254740993n;
      for (let i = 256; i < 511; i++)
        ids[i] = 9007199254740993n + BigInt(i - 256) * 11n;
      ids[511] = 9223372036854775807n;
      db.transaction(() => {
        for (const id of ids) insert.run(id);
      })();
      db.defaultSafeIntegers(true);
      for (const count of [512, 511]) {
        const output = capture();
        const result = await exportTable(db, "users", {
          columns: ["id"],
          format,
          output: output.stream,
        });
        const records = db
          .prepare("SELECT json_object('id',id) FROM users ORDER BY rowid")
          .pluck()
          .all() as string[];
        expect(output.text()).toBe(
          format === "json"
            ? `[${records.join(",")}]`
            : `${records.join("\n")}\n`,
        );
        expect(result.rowsExported).toBe(count);
        db.prepare("DELETE FROM users WHERE id = ?").run(ids[511]);
      }
    },
  );

  it("qualifies batch bounds when source columns shadow both rowid aliases and bound names", async () => {
    db.exec(
      "CREATE TABLE aliases(rowid TEXT, _rowid_ TEXT, first TEXT, last TEXT); INSERT INTO aliases(oid,rowid,_rowid_,first,last) VALUES(-9223372036854775808,'r','s','a','b'),(9223372036854775807,'t','u','c','d')",
    );
    const output = capture();
    await exportTable(db, "aliases", { output: output.stream, format: "json" });
    expect(JSON.parse(output.text())).toEqual([
      { rowid: "r", _rowid_: "s", first: "a", last: "b" },
      { rowid: "t", _rowid_: "u", first: "c", last: "d" },
    ]);
  });

  it("does not confuse a table or column name with the recursive CTE", async () => {
    db.exec(
      "CREATE TABLE __exportlite_batches(bounds TEXT); INSERT INTO __exportlite_batches VALUES('first'),('second')",
    );
    const output = capture();
    await exportTable(db, "__exportlite_batches", {
      format: "json",
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual([
      { bounds: "first" },
      { bounds: "second" },
    ]);
  });

  it.each(
    [
      {
        table: "no_rowid",
        setup:
          "CREATE TABLE no_rowid(id TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO no_rowid VALUES('b'),('a')",
      },
      {
        table: "user_view",
        setup:
          "CREATE VIEW user_view AS SELECT * FROM users ORDER BY id DESC LIMIT 3",
      },
      {
        table: "shadowed",
        setup:
          "CREATE TABLE shadowed(rowid,_rowid_,oid); INSERT INTO shadowed VALUES('r',2,NULL),('s',3,'o')",
      },
      {
        table: "docs",
        setup:
          "CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs VALUES('first'),('雪 second')",
      },
    ].flatMap((fixture) =>
      (["json", "jsonl"] as const).map((format) => ({ ...fixture, format })),
    ),
  )(
    "streams $table through the $format fallback",
    async ({ table, setup, format }) => {
      db.exec(setup);
      expect(planTable(db, table, undefined, format).batched).toBe(false);
      const output = capture();
      const result = await exportTable(db, table, {
        format,
        output: output.stream,
      });
      const expected = db.prepare(`SELECT * FROM main."${table}"`).all();
      expect(decode(output.text(), format)).toEqual(expected);
      expect(result.rowsExported).toBe(expected.length);
      expect(result.bytesWritten).toBe(Buffer.byteLength(output.text()));
    },
  );

  it.each([
    { batchSize: 256 },
    { batchSize: "adaptive" },
    { targetBatchBytes: 262144 },
    { batchEstimator: "p95" },
  ])(
    "rejects retired sizing options before opening output: %o",
    async (retired) => {
      const options = { ...retired, output: join(directory, "invalid.json") };
      await expect(exportTable(db, "users", options)).rejects.toHaveProperty(
        "code",
        "INVALID_OPTIONS",
      );
      await expect(
        exportQuery(db, { ...options, sql: "SELECT * FROM users" }),
      ).rejects.toHaveProperty("code", "INVALID_OPTIONS");
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("keeps the batch frontier streaming with indexed seeks", () => {
    const { statement, batched } = planTable(db, "users", undefined, "json");
    expect(batched).toBe(true);
    if (!("source" in statement) || typeof statement.source !== "string")
      throw new Error("Expected driver's SQL source");
    const steps = db
      .prepare(`EXPLAIN QUERY PLAN ${statement.source}`)
      .all() as { detail: string }[];
    const details = steps.map((step) => step.detail).join("\n");
    expect(details).toContain("CO-ROUTINE __exportlite_batches");
    expect(details).toMatch(/SEARCH .* USING INTEGER PRIMARY KEY/);
    expect(details).not.toMatch(/USE TEMP B-TREE|MATERIALIZE/i);
  });

  it("retains ownership of an existing caller transaction", async () => {
    db.exec("BEGIN");
    try {
      const output = capture();
      await exportTable(db, "users", { output: output.stream, end: true });
      expect(db.inTransaction).toBe(true);
      expect(output.stream.writableFinished).toBe(true);
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it.each(["users", "user_view"])(
    "pauses $table computation under backpressure",
    async (table) => {
      let computed = 0;
      db.function("observed", { deterministic: true }, (value) => {
        computed++;
        return value;
      });
      db.exec(
        "ALTER TABLE users ADD COLUMN seen GENERATED ALWAYS AS (observed(id)) VIRTUAL; CREATE VIEW user_view AS SELECT * FROM users",
      );
      let release: (() => void) | undefined;
      let hold = true;
      const output = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (hold) release = callback;
          else callback();
        },
      });
      const pending = exportTable(db, table, {
        columns: ["id", "seen"],
        bufferSize: 1,
        output,
      });
      await setImmediate();
      expect(computed).toBe(table === "users" ? 256 : 1);
      expect(output.writableNeedDrain).toBe(true);
      hold = false;
      release?.();
      await expect(pending).resolves.toHaveProperty("rowsExported", 513);
      expect(computed).toBe(513);
    },
  );

  it("cancels a blocked export and releases its statement without ending the caller stream", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const pending = exportTable(db, "users", {
      bufferSize: 1,
      signal: controller.signal,
      output,
    });
    await setImmediate();
    const assertion = expect(pending).rejects.toHaveProperty("code", "ABORTED");
    controller.abort();
    await assertion;
    expect(output.destroyed).toBe(false);
    release?.();
    output.end();
    expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(513);
  });

  it("removes a partial file after a later batch contains a BLOB", async () => {
    db.exec("UPDATE users SET note=x'1234' WHERE id=1539");
    await expect(
      exportTable(db, "users", {
        bufferSize: 1,
        output: join(directory, "partial.json"),
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      message: expect.stringContaining("BLOB"),
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("checks cancellation after yielding before computing the next batch", async () => {
    seed(5000);
    const controller = new AbortController();
    let computed = 0;
    db.function("observed", { deterministic: true }, (value) => {
      computed++;
      if (computed === 1) setImmediate().then(() => controller.abort());
      return value;
    });
    db.exec(
      "ALTER TABLE users ADD COLUMN seen GENERATED ALWAYS AS (observed(id)) VIRTUAL",
    );
    await expect(
      exportTable(db, "users", {
        columns: ["id", "seen"],
        bufferSize: 16_777_216,
        signal: controller.signal,
        output: capture().stream,
      }),
    ).rejects.toHaveProperty("code", "ABORTED");
    expect(computed).toBe(2048);
  });

  it("propagates asynchronous output errors while a batch is pending", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate().then(() => callback(new Error("disk full")));
      },
    });
    await expect(exportTable(db, "users", { output })).rejects.toHaveProperty(
      "code",
      "OUTPUT_ERROR",
    );
  });

  it("keeps one snapshot while a separate WAL writer changes future rows", async () => {
    const path = join(directory, "snapshot.sqlite");
    const writer = new Database(path);
    writer.pragma("journal_mode=WAL");
    writer.exec(
      "CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT); WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<513) INSERT INTO entries SELECT x,'old-'||x FROM n",
    );
    const reader = new Database(path, { readonly: true });
    const expected = writer.prepare("SELECT * FROM entries ORDER BY id").all();
    const chunks: Buffer[] = [];
    let release: (() => void) | undefined;
    let hold = true;
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (hold) release = callback;
        else callback();
      },
    });
    const pending = exportTable(reader, "entries", { bufferSize: 1, output });
    try {
      await setImmediate();
      expect(release).toBeTypeOf("function");
      writer.exec(
        "UPDATE entries SET value='changed' WHERE id=400; INSERT INTO entries VALUES(514,'new')",
      );
      hold = false;
      release?.();
      release = undefined;
      await expect(pending).resolves.toHaveProperty("rowsExported", 513);
      expect(decode(Buffer.concat(chunks).toString("utf8"), "jsonl")).toEqual(
        expected,
      );
      expect(reader.inTransaction).toBe(false);
    } finally {
      hold = false;
      release?.();
      await pending.catch(() => {});
      reader.close();
      writer.close();
    }
  });
});
