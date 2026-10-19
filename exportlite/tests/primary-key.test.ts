import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import {
  type DatabaseEncoding,
  exportTable,
  integer,
  type SQLiteConnection,
  text,
} from "../src/index.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => db.close());
const columns = { key: integer("id").primaryKey(), label: text("name") };

function seed(connection: Database.Database, count: number) {
  connection.exec("CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT)");
  const insert = connection.prepare("INSERT INTO data VALUES(?, ?)");
  connection.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(i * 3 - 10, `雪 🦦 "${i}"\n`);
  })();
}

function track(connection: Database.Database) {
  const prepared: string[] = [];
  const batchSizes: number[] = [];
  let executions = 0;
  const adapter: SQLiteConnection = {
    prepare(sql) {
      prepared.push(sql);
      expect(sql).not.toMatch(/pragma|sqlite_schema|sqlite_version/);
      const statement = connection.prepare(sql);
      statement.columns = () => {
        throw new Error("No column metadata reads");
      };
      statement.get = () => {
        throw new Error("No preflight get");
      };
      statement.all = () => {
        throw new Error("No preflight all");
      };
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        executions++;
        for (const value of iterate(...params)) {
          if (Array.isArray(value)) batchSizes.push(Number(value[1]));
          yield value;
        }
      };
      return statement;
    },
  };
  return { adapter, prepared, batchSizes, executions: () => executions };
}

it.each(
  [0, 1, 255, 256, 257, 512, 513].flatMap((count) =>
    (["json", "jsonl"] as const).map((format) => ({ count, format })),
  ),
)(
  "executes one cold statement for $count rows of $format without preflight queries",
  async ({ count, format }) => {
    seed(db, count);
    const tracked = track(db);
    const stream = await exportTable(tracked.adapter, "data", {
      columns,
      format,
    });
    expect(tracked.prepared).toHaveLength(1);
    expect(tracked.executions()).toBe(0);
    const body = await new Response(stream).text();
    const rows =
      format === "json"
        ? JSON.parse(body)
        : body
          ? body
              .trimEnd()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
    expect(rows).toEqual(
      db.prepare("SELECT id AS key,name AS label FROM data ORDER BY id").all(),
    );
    expect((await stream.result).rowsExported).toBe(count);
    expect(tracked.executions()).toBe(1);
    expect(tracked.batchSizes.filter((size) => size > 0)).toEqual(
      Array.from({ length: Math.ceil(count / 256) }, (_, i) =>
        Math.min(256, count - i * 256),
      ),
    );
    const again = await exportTable(tracked.adapter, "data", {
      columns,
      format,
    });
    expect(await new Response(again).text()).toBe(body);
    await again.result;
    expect(tracked.prepared).toHaveLength(2);
  },
);

it.each(["rowid-shadowed", "without-rowid", "secondary-key"])(
  "uses the declared integer key on a %s table",
  async (kind) => {
    if (kind === "rowid-shadowed")
      db.exec(
        "CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT,rowid TEXT,_rowid_ TEXT,oid TEXT)",
      );
    else if (kind === "without-rowid")
      db.exec(
        "CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT) WITHOUT ROWID",
      );
    else
      db.exec(
        "CREATE TABLE data(internal INTEGER PRIMARY KEY,id INTEGER UNIQUE NOT NULL,name TEXT)",
      );
    const insert = db.prepare("INSERT INTO data(id,name) VALUES(?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 513; i++) insert.run(i * 9 - 1000, `雪 ${i}`);
    })();
    const tracked = track(db);
    const stream = await exportTable(tracked.adapter, "data", {
      columns,
      format: "json",
    });
    expect(await new Response(stream).json()).toEqual(
      db.prepare("SELECT id AS key,name AS label FROM data ORDER BY id").all(),
    );
    await stream.result;
    expect(tracked.batchSizes).toEqual([256, 256, 1]);
  },
);

it("preserves 64-bit key boundaries and BigInt-configured connections", async () => {
  seed(db, 256);
  db.exec(
    "INSERT INTO data VALUES(-9223372036854775808,'min'),(9223372036854775807,'max')",
  );
  db.defaultSafeIntegers(true);
  const stream = await exportTable(track(db).adapter, "data", {
    columns,
    format: "json",
  });
  const body = await new Response(stream).text();
  expect(body).toBe(
    db
      .prepare(
        "SELECT json_group_array(json_object('key',id,'label',name)) FROM (SELECT id,name FROM data ORDER BY id)",
      )
      .pluck()
      .get(),
  );
  expect(body).toContain("-9223372036854775808");
  expect(body).toContain("9223372036854775807");
  expect((await stream.result).rowsExported).toBe(258);
});

it.each(["missing-key", "text-key", "composite-key"])(
  "keeps row streaming without preflight reads for a %s declaration",
  async (kind) => {
    seed(db, 3);
    const selection =
      kind === "missing-key"
        ? { key: integer("id"), label: text("name") }
        : kind === "text-key"
          ? { key: integer("id"), label: text("name").primaryKey() }
          : {
              key: integer("id").primaryKey(),
              label: text("name").primaryKey(),
            };
    const tracked = track(db);
    const stream = await exportTable(tracked.adapter, "data", {
      columns: selection,
      format: "json",
    });
    expect(await new Response(stream).json()).toEqual(
      db.prepare("SELECT id AS key,name AS label FROM data").all(),
    );
    await stream.result;
    expect(tracked.prepared).toHaveLength(1);
    expect(tracked.prepared[0]).not.toContain("WITH RECURSIVE");
  },
);

it.each(
  (["utf16le", "utf16be"] as const).flatMap((encoding) =>
    (["json", "jsonl"] as const).flatMap((format) =>
      [false, true].map((zip) => ({ encoding, format, zip })),
    ),
  ),
)(
  "streams correct UTF-8 from a $encoding database, $format, zip=$zip",
  async ({ encoding, format, zip }) => {
    db.pragma(`encoding='${encoding === "utf16le" ? "UTF-16le" : "UTF-16be"}'`);
    seed(db, 257);
    const tracked = track(db);
    const stream = await exportTable(tracked.adapter, "data", {
      columns,
      format,
      zip,
      encoding,
    });
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    let body = bytes.toString("utf8");
    if (zip) {
      const archive = await fromBufferPromise(bytes);
      try {
        for await (const entry of archive.eachEntry()) {
          const parts: Buffer[] = [];
          for await (const part of await archive.openReadStreamPromise(entry))
            parts.push(part);
          body = Buffer.concat(parts).toString("utf8");
        }
      } finally {
        archive.close();
      }
    }
    const rows =
      format === "json"
        ? JSON.parse(body)
        : body
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
    expect(rows).toEqual(
      db.prepare("SELECT id AS key,name AS label FROM data ORDER BY id").all(),
    );
    await stream.result;
    expect(tracked.prepared).toHaveLength(1);
    expect(tracked.batchSizes).toEqual([256, 1]);
  },
);

it.each(["UTF-16le", "UTF-16be"])(
  "rejects the UTF-8 default on a %s database without returning corrupt JSON",
  async (encoding) => {
    db.pragma(`encoding='${encoding}'`);
    seed(db, 1);
    const tracked = track(db);
    const stream = await exportTable(tracked.adapter, "data", {
      columns,
      format: "json",
    });
    await expect(new Response(stream).text()).rejects.toThrow(/encoding/);
    await expect(stream.result).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(tracked.prepared).toHaveLength(1);
  },
);

it("reuses independent cached plans across data and schema changes", async () => {
  seed(db, 257);
  const tracked = track(db);
  const first = await exportTable(tracked.adapter, "data", {
    columns,
    format: "json",
  });
  const second = await exportTable(tracked.adapter, "data", {
    columns,
    format: "json",
  });
  await first.cancel();
  expect(((await new Response(second).json()) as unknown[]).length).toBe(257);
  await second.result;
  db.exec(
    "DROP TABLE data; CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT) WITHOUT ROWID; INSERT INTO data VALUES(7,'new')",
  );
  const rebuilt = await exportTable(tracked.adapter, "data", {
    columns,
    format: "json",
  });
  expect(await new Response(rebuilt).json()).toEqual([
    { key: 7, label: "new" },
  ]);
  await rebuilt.result;
  db.exec("ALTER TABLE data RENAME COLUMN id TO renamed");
  await expect(
    exportTable(tracked.adapter, "data", { columns }),
  ).rejects.toHaveProperty("code");
});

it("rejects a nullable declared key instead of silently skipping rows", async () => {
  db.exec(
    "CREATE TABLE data(id INT PRIMARY KEY,name TEXT); INSERT INTO data VALUES(NULL,'bad'),(1,'valid')",
  );
  const stream = await exportTable(db, "data", { columns, format: "json" });
  await expect(new Response(stream).text()).rejects.toThrow();
  await expect(stream.result).rejects.toMatchObject({ code: "SQLITE_ERROR" });
});

it.each([false, true])(
  "removes a failed declared export file, zip=%s",
  async (zip) => {
    seed(db, 513);
    db.function("fail_later", (value) => {
      if (Number(value) > 800) throw new Error("late failure");
      return value;
    });
    db.exec("CREATE VIEW broken AS SELECT id,fail_later(id) AS name FROM data");
    const directory = await mkdtemp(
      join(tmpdir(), "exportlite-declared-failure-"),
    );
    try {
      await expect(
        exportTable(db, "broken", {
          columns,
          zip,
          format: "json",
          output: join(directory, zip ? "bad.zip" : "bad.json"),
          bufferSize: 1,
        }),
      ).rejects.toHaveProperty("code");
      expect(await readdir(directory)).toEqual([]);
      expect(db.prepare("SELECT 1").pluck().get()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves backpressure and cancellation on declared batches", async () => {
  seed(db, 513);
  const tracked = track(db);
  const controller = new AbortController();
  let writes = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes++;
      setImmediate().then(() => {
        if (writes === 2) controller.abort();
        callback();
      });
    },
  });
  await expect(
    exportTable(tracked.adapter, "data", {
      columns,
      output,
      format: "json",
      bufferSize: 1,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(tracked.batchSizes).toEqual([256]);
  expect(output.writableEnded).toBe(false);
  expect(output.listenerCount("error")).toBe(0);
  output.destroy();
  expect(db.prepare("SELECT 1").pluck().get()).toBe(1);
});

it("declares primary keys immutably and validates encoding before touching the database", async () => {
  const original = integer("id");
  const primary = original.primaryKey();
  expect(original.primary).toBe(false);
  expect(original.required).toBe(false);
  expect(primary.primary).toBe(true);
  expect(primary.notNull().primary).toBe(true);
  expect(primary.required).toBe(true);
  const forbidden: SQLiteConnection = {
    prepare() {
      throw new Error("Must not access database");
    },
  };
  await expect(
    exportTable(forbidden, "data", {
      columns,
      encoding: "latin1" as DatabaseEncoding,
    }),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
});
