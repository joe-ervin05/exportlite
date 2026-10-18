import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportQuery,
  exportTable,
  type SQLiteConnection,
} from "../src/index.js";

function capture(options: { highWaterMark?: number; delay?: number } = {}) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: options.highWaterMark ?? 65_536,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (options.delay) setTimeout(callback, options.delay);
      else callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

let db: Database.Database;
let directory: string;
beforeEach(async () => {
  db = new Database(":memory:");
  directory = await mkdtemp(join(tmpdir(), "exportlite-test-"));
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, note TEXT, active INTEGER)",
  );
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run(
    1,
    'Jóe 雪 "quoted"\nline',
    null,
    1,
  );
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run(
    2,
    "",
    '{"stored":true}',
    0,
  );
});
afterEach(async () => {
  // Closing also proves no busy iterator was left behind after a failure.
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("native JSON exports", () => {
  it("streams JSONL by default, preserving text, NULL, and byte statistics", async () => {
    const output = capture();
    const result = await exportTable(db, "users", { output: output.stream });
    const rows = output
      .text()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toEqual(db.prepare("SELECT * FROM users").all());
    expect(result.rowsExported).toBe(2);
    expect(result.bytesWritten).toBe(Buffer.byteLength(output.text()));
    expect(result.durationMs).toBeGreaterThan(0);
    expect(output.stream.writableEnded).toBe(false);
    expect(output.stream.listenerCount("error")).toBe(0);
    expect(output.stream.listenerCount("drain")).toBe(0);
  });

  it("produces complete JSON arrays with selected columns", async () => {
    const output = capture();
    await exportTable(db, "users", {
      format: "json",
      columns: ["name", "id"],
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual(
      db.prepare("SELECT name, id FROM users").all(),
    );
  });

  it.each(["json", "jsonl"] as const)(
    "handles empty %s results",
    async (format) => {
      const output = capture();
      const result = await exportQuery(db, {
        sql: "SELECT * FROM users WHERE 0",
        format,
        output: output.stream,
      });
      expect(output.text()).toBe(format === "json" ? "[]" : "");
      expect(result.rowsExported).toBe(0);
      expect(result.bytesWritten).toBe(format === "json" ? 2 : 0);
    },
  );

  it("binds positional and named values without changing query order or limits", async () => {
    for (const params of [[0], { active: 0 }]) {
      const output = capture();
      await exportQuery(db, {
        sql: `SELECT id, name FROM users WHERE active = ${Array.isArray(params) ? "?" : "@active"} ORDER BY id DESC LIMIT 1; -- trailing comment`,
        params,
        format: "json",
        output: output.stream,
      });
      expect(JSON.parse(output.text())).toEqual([{ id: 2, name: "" }]);
    }
  });

  it("handles CTEs, semicolons inside literals, quoted aliases and trailing comments", async () => {
    const output = capture();
    await exportQuery(db, {
      sql: "WITH x AS (SELECT 'it''s; -- /*' AS [a;b]) SELECT [a;b] AS \"odd\"\"name\" FROM x; /* final */",
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual({ 'odd"name': "it's; -- /*" });
  });

  it("preserves case-distinct aliases and integer-like property names", async () => {
    const output = capture();
    await exportQuery(db, {
      sql: 'SELECT 1 AS name, 2 AS NAME, 3 AS "1", 4 AS "0"',
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual({ name: 1, NAME: 2, 1: 3, 0: 4 });
  });

  it("preserves 64-bit integer literals without a JavaScript number conversion", async () => {
    const output = capture();
    await exportQuery(db, {
      sql: "SELECT 9223372036854775807 AS n, -9223372036854775808 AS m",
      output: output.stream,
    });
    expect(output.text()).toBe(
      '{"n":9223372036854775807,"m":-9223372036854775808}\n',
    );
  });

  it("supports an existing connection configured to return integers as BigInt", async () => {
    db.defaultSafeIntegers(true);
    const output = capture();
    await exportTable(db, "users", {
      output: output.stream,
      format: "json",
    });
    expect(JSON.parse(output.text())).toEqual(
      db.prepare("SELECT * FROM users").safeIntegers(false).all(),
    );
    expect(db.prepare("SELECT 1").pluck().get()).toBe(1n);
  });

  it("treats JSON stored as TEXT as a string", async () => {
    const output = capture();
    await exportQuery(db, {
      sql: "SELECT note FROM users WHERE id = 2",
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual({ note: '{"stored":true}' });
  });

  it("does not shadow a table whose name matches the query wrapper", async () => {
    db.exec(
      'CREATE TABLE "__exportlite_source" (n); INSERT INTO "__exportlite_source" VALUES (42)',
    );
    const output = capture();
    await exportQuery(db, {
      sql: 'SELECT n FROM "__exportlite_source"',
      output: output.stream,
    });
    expect(JSON.parse(output.text())).toEqual({ n: 42 });
  });

  it("validates and quotes unusual schema identifiers, including generated columns", async () => {
    db.exec(
      'CREATE TABLE "odd""table" ("a\'b" TEXT, base INTEGER, generated INTEGER GENERATED ALWAYS AS (base * 2))',
    );
    db.exec('INSERT INTO "odd""table" ("a\'b", base) VALUES (\'hello\', 3)');
    const ordinary = capture();
    await exportTable(db, 'odd"table', { output: ordinary.stream });
    expect(JSON.parse(ordinary.text())).toEqual({ "a'b": "hello", base: 3 });
    const generated = capture();
    await exportTable(db, 'odd"table', {
      columns: ["generated"],
      output: generated.stream,
    });
    expect(JSON.parse(generated.text())).toEqual({ generated: 6 });
  });

  it("exports views and WITHOUT ROWID tables", async () => {
    db.exec(
      "CREATE TABLE pair (a TEXT, b INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID; INSERT INTO pair VALUES ('x', 1); CREATE VIEW pair_view AS SELECT * FROM pair",
    );
    for (const table of ["pair", "pair_view"]) {
      const output = capture();
      await exportTable(db, table, { output: output.stream });
      expect(JSON.parse(output.text())).toEqual({ a: "x", b: 1 });
    }
  });
});

describe("validation and failures", () => {
  it.each([
    "INSERT INTO users (id) VALUES (3)",
    "INSERT INTO users (id) VALUES (3) RETURNING id",
    "DELETE FROM users RETURNING id",
    "SELECT id FROM users; DELETE FROM users",
  ])(
    "rejects mutations/multiple statements before executing: %s",
    async (sql) => {
      await expect(
        exportQuery(db, { sql, output: join(directory, "bad.json") }),
      ).rejects.toHaveProperty("code", "INVALID_QUERY");
      expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(2);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("rejects PRAGMAs before preparing them can change connection settings", async () => {
    db.pragma("foreign_keys = ON");
    await expect(
      exportQuery(db, {
        sql: "/* config */ PRAGMA foreign_keys = OFF",
        output: capture().stream,
      }),
    ).rejects.toHaveProperty("code", "INVALID_QUERY");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("rejects duplicate aliases before SQLite can silently rename them", async () => {
    await expect(
      exportQuery(db, {
        sql: "SELECT id AS x, name AS x FROM users",
        output: join(directory, "bad.json"),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_SCHEMA",
      message: expect.stringContaining("Duplicate"),
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(
    [[], ["id", "id"], ["does not exist"], ['name"; DROP TABLE users;--']].map(
      (columns) => ({ columns }),
    ),
  )("rejects invalid column selection $columns", async ({ columns }) => {
    await expect(
      exportTable(db, "users", {
        columns,
        output: join(directory, "bad.json"),
      }),
    ).rejects.toHaveProperty("code", "INVALID_SCHEMA");
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects missing tables and unsupported formats before opening the output", async () => {
    await expect(
      exportTable(db, "missing", { output: join(directory, "missing.json") }),
    ).rejects.toHaveProperty("code", "INVALID_SCHEMA");
    await expect(
      exportTable(db, "users", {
        format: "csv" as "json",
        output: join(directory, "bad.csv"),
      }),
    ).rejects.toHaveProperty("code", "INVALID_OPTIONS");
    expect(await readdir(directory)).toEqual([]);
  });

  it("checks the SQLite version and JSON capabilities", async () => {
    const connection: SQLiteConnection = {
      prepare(sql) {
        return db.prepare(sql.replace("sqlite_version()", "'3.44.0'"));
      },
    };
    await expect(
      exportTable(connection, "users", { output: capture().stream }),
    ).rejects.toHaveProperty("code", "UNSUPPORTED_SQLITE");
  });

  it("cleans up a newly created partial file after SQLite serialization fails", async () => {
    db.exec(
      "CREATE TABLE blobs (value); INSERT INTO blobs VALUES ('first'), (x'1234')",
    );
    await expect(
      exportTable(db, "blobs", {
        output: join(directory, "partial.json"),
        bufferSize: 1,
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      message: expect.stringContaining("BLOB"),
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates binding failures and releases the iterator", async () => {
    await expect(
      exportQuery(db, { sql: "SELECT ? AS value", output: capture().stream }),
    ).rejects.toHaveProperty("code", "SQLITE_ERROR");
    expect(db.prepare("SELECT 1").pluck().get()).toBe(1);
  });
});

describe("output ownership, backpressure and cancellation", () => {
  it("creates a complete file and refuses to overwrite an existing file", async () => {
    const path = join(directory, "users.json");
    const result = await exportTable(db, "users", {
      output: path,
      format: "json",
    });
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual(db.prepare("SELECT * FROM users").all());
    expect(result.bytesWritten).toBe(Buffer.byteLength(text));
    await expect(
      exportTable(db, "users", { output: path }),
    ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("does not pull the next SQLite record while a slow destination is blocked", async () => {
    let stepped = 0;
    let release: (() => void) | undefined;
    let hold = true;
    db.function("observed", (value) => {
      stepped++;
      return value;
    });
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        if (hold) release = callback;
        else callback();
      },
    });
    const pending = exportQuery(db, {
      sql: "SELECT observed(id) AS id FROM users",
      output,
      bufferSize: 1,
    });
    await setImmediate();
    expect(stepped).toBe(1);
    expect(output.writableNeedDrain).toBe(true);
    hold = false;
    release?.();
    await expect(pending).resolves.toHaveProperty("rowsExported", 2);
    expect(stepped).toBe(2);
  });

  it("waits for the final asynchronous write callback without ending a caller stream", async () => {
    const output = capture({ highWaterMark: 1024, delay: 15 });
    const result = await exportTable(db, "users", { output: output.stream });
    expect(result.rowsExported).toBe(2);
    expect(output.stream.writableLength).toBe(0);
    expect(output.stream.writableEnded).toBe(false);
    output.stream.end("tail");
  });

  it("ends a caller stream only when requested", async () => {
    const output = capture();
    await exportTable(db, "users", { output: output.stream, end: true });
    expect(output.stream.writableFinished).toBe(true);
  });

  it("propagates errors that occur during finalization", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback(new Error("final failed"));
      },
    });
    await expect(
      exportTable(db, "users", { output, end: true }),
    ).rejects.toMatchObject({
      code: "OUTPUT_ERROR",
      message: expect.stringContaining("final failed"),
    });
  });

  it("cancels while waiting for a caller stream to finalize", async () => {
    const controller = new AbortController();
    let completeFinal: (() => void) | undefined;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        completeFinal = callback;
      },
    });
    const pending = exportTable(db, "users", {
      output,
      end: true,
      signal: controller.signal,
    });
    await setImmediate();
    expect(completeFinal).toBeTypeOf("function");
    const assertion = expect(pending).rejects.toHaveProperty("code", "ABORTED");
    controller.abort();
    await assertion;
    completeFinal?.();
  });

  it("yields so a timer can cancel even a synchronous memory destination", async () => {
    let stepped = 0;
    db.exec(
      "CREATE TABLE many (id); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO many SELECT x FROM n",
    );
    db.function("observed", (n) => {
      stepped++;
      return n;
    });
    const controller = new AbortController();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        exportQuery(db, {
          sql: "SELECT observed(id) AS id FROM many",
          output,
          signal: controller.signal,
        }),
      ).rejects.toHaveProperty("code", "ABORTED");
      expect(stepped).toBeGreaterThanOrEqual(2048);
      expect(stepped).toBeLessThan(100000);
    } finally {
      clearTimeout(timer);
    }
  });

  it("propagates asynchronous destination errors", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate().then(() => callback(new Error("disk full")));
      },
    });
    await expect(exportTable(db, "users", { output })).rejects.toMatchObject({
      code: "OUTPUT_ERROR",
      message: expect.stringContaining("disk full"),
    });
  });

  it("rejects when a destination closes without draining", async () => {
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        setImmediate().then(() => output.destroy());
      },
    });
    await expect(
      exportTable(db, "users", { output, bufferSize: 1 }),
    ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
  });

  it("cancels while awaiting backpressure and leaves the caller stream open", async () => {
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
      signal: controller.signal,
      bufferSize: 1,
    });
    await setImmediate();
    const assertion = expect(pending).rejects.toHaveProperty("code", "ABORTED");
    controller.abort("cancel test");
    await assertion;
    expect(output.destroyed).toBe(false);
    release?.();
    output.end();
  });

  it("honors pre-aborted signals without creating a file", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportTable(db, "users", {
        output: join(directory, "abort.json"),
        signal: controller.signal,
      }),
    ).rejects.toHaveProperty("code", "ABORTED");
    expect(await readdir(directory)).toEqual([]);
  });

  it("yields to timers during long exports, then removes a cancelled partial file", async () => {
    db.exec(
      "CREATE TABLE many (id INTEGER); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 100000) INSERT INTO many SELECT x FROM n",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1);
    try {
      await expect(
        exportTable(db, "many", {
          output: join(directory, "abort.json"),
          signal: controller.signal,
        }),
      ).rejects.toHaveProperty("code", "ABORTED");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("leaves a preexisting file untouched on cancellation", async () => {
    const path = join(directory, "existing.json");
    await writeFile(path, "keep");
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportTable(db, "users", { output: path, signal: controller.signal }),
    ).rejects.toHaveProperty("code", "ABORTED");
    expect(await readFile(path, "utf8")).toBe("keep");
  });
});
