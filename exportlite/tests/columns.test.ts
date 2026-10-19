import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import {
  exportQuery,
  exportTable,
  integer,
  real,
  type SelectedColumns,
  type SQLiteConnection,
  text,
} from "../src/index.js";
import { planTable } from "../src/planner/json.js";

let db: Database.Database;
const columns = {
  userId: integer("id").primaryKey(),
  displayName: text("name").notNull(),
  email: text(),
  enabled: integer("active", { mode: "boolean" }),
  score: real(),
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, active INTEGER, score REAL)",
  );
  const insert = db.prepare("INSERT INTO users VALUES(?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let id = 1; id <= 513; id++)
      insert.run(id * 3, `雪 "${id}"`, id % 2 ? null : "a@b.test", id % 2, 1.5);
  })();
});
afterEach(() => db.close());

it.each(["json", "jsonl"] as const)(
  "renames and types fields across fixed %s batch boundaries",
  async (format) => {
    const plan = planTable(db, "users", columns, format);
    expect(plan.batched).toBe(true);
    const sizes = [...plan.statement.raw().iterate()].map((row) =>
      Number((row as unknown[])[1]),
    );
    expect(sizes).toEqual([256, 256, 1]);
    const stream = await exportTable(db, "users", { columns, format });
    const body = await new Response(stream).text();
    const rows =
      format === "json"
        ? JSON.parse(body)
        : body
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(513);
    expect(rows[0]).toEqual({
      userId: 3,
      displayName: '雪 "1"',
      email: null,
      enabled: true,
      score: 1.5,
    });
    expect(rows[512].userId).toBe(1539);
    expect((await stream.result).rowsExported).toBe(513);
  },
);

it.each(["view", "without-rowid", "shadowed-rowid"])(
  "keeps declared aliases on the %s fallback",
  async (kind) => {
    if (kind === "view")
      db.exec("CREATE VIEW source AS SELECT id,name FROM users");
    else if (kind === "without-rowid")
      db.exec(
        "CREATE TABLE source(id INTEGER PRIMARY KEY,name TEXT) WITHOUT ROWID; INSERT INTO source SELECT id,name FROM users",
      );
    else
      db.exec(
        "CREATE TABLE source(id INTEGER,name TEXT,rowid TEXT,_rowid_ TEXT,oid TEXT); INSERT INTO source(id,name) SELECT id,name FROM users",
      );
    const selection = {
      label: text("name"),
      first: integer("id"),
      again: integer("id"),
    };
    expect(planTable(db, "source", selection).batched).toBe(false);
    const stream = await exportTable(db, "source", {
      columns: selection,
      format: "json",
    });
    const rows = (await new Response(stream).json()) as Record<
      string,
      unknown
    >[];
    expect(rows[0]).toEqual({ label: '雪 "1"', first: 3, again: 3 });
    await stream.result;
  },
);

it("prepares and executes only one declared query, with no capability or schema reads", async () => {
  const prepared: string[] = [];
  let executions = 0;
  const connection: SQLiteConnection = {
    prepare(sql) {
      prepared.push(sql);
      const statement = db.prepare(sql);
      statement.columns = () => {
        throw new Error("Metadata must not be discovered");
      };
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        executions++;
        yield* iterate(...params);
      };
      return statement;
    },
  };
  const stream = await exportQuery(connection, {
    sql: "SELECT * FROM users WHERE id > @min ORDER BY id LIMIT 2; -- final comment",
    params: { min: 3 },
    columns,
    format: "json",
  });
  expect(prepared).toHaveLength(1);
  expect(prepared[0]).not.toMatch(/pragma|sqlite_schema|sqlite_version/);
  expect(executions).toBe(0);
  const rows = (await new Response(stream).json()) as Record<string, unknown>[];
  expect(rows.map((row) => row.userId)).toEqual([6, 9]);
  expect(rows[0]?.enabled).toBe(false);
  expect(executions).toBe(1);
  await stream.result;
});

it("keeps request aliases in cached plans and invalidates table plans after schema changes", async () => {
  for (const key of ["first", "second", "first"]) {
    const stream = await exportTable(db, "users", {
      columns: { [key]: integer("id") },
      format: "json",
    });
    expect(((await new Response(stream).json()) as unknown[])[0]).toEqual({
      [key]: 3,
    });
    await stream.result;
  }
  db.exec(
    "ALTER TABLE users ADD COLUMN extra TEXT; UPDATE users SET name='fresh' WHERE id=3",
  );
  const stream = await exportTable(db, "users", { columns, format: "json" });
  expect(
    ((await new Response(stream).json()) as Record<string, unknown>[])[0]
      ?.displayName,
  ).toBe("fresh");
  await stream.result;
  db.exec("ALTER TABLE users RENAME COLUMN name TO renamed");
  await expect(exportTable(db, "users", { columns })).rejects.toMatchObject({
    code: "INVALID_QUERY",
  });
});

it("rejects missing declared fields during preparation instead of emitting quoted literals", async () => {
  await expect(
    exportQuery(db, {
      sql: "SELECT id FROM users",
      columns: { absent: text() },
    }),
  ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  await expect(
    exportQuery(db, {
      sql: "SELECT id FROM users",
      columns: { renamed: text("absent") },
    }),
  ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  await expect(
    exportTable(db, "users", { columns: { renamed: text("absent") } }),
  ).rejects.toMatchObject({ code: "INVALID_QUERY" });
});

it("quotes source names and output keys, including case-distinct aliases and repeated sources", async () => {
  db.exec(`CREATE TABLE odd("a""b" TEXT); INSERT INTO odd VALUES('quoted')`);
  const selection = { "o'k": text('a"b'), A: text('a"b'), a: text('a"b') };
  for (const stream of [
    await exportTable(db, "odd", { columns: selection, format: "json" }),
    await exportQuery(db, {
      sql: "SELECT * FROM odd",
      columns: selection,
      format: "json",
    }),
  ]) {
    expect(await new Response(stream).json()).toEqual([
      { "o'k": "quoted", A: "quoted", a: "quoted" },
    ]);
    await stream.result;
  }
});

it.each(["table", "query"])(
  "decodes a declared %s ZIP using the same output pipeline",
  async (kind) => {
    const stream =
      kind === "table"
        ? await exportTable(db, "users", { columns, format: "json", zip: true })
        : await exportQuery(db, {
            sql: "SELECT * FROM users ORDER BY id",
            columns,
            format: "json",
            zip: true,
          });
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    const archive = await fromBufferPromise(bytes);
    try {
      for await (const entry of archive.eachEntry()) {
        const parts: Buffer[] = [];
        for await (const part of await archive.openReadStreamPromise(entry))
          parts.push(part);
        expect(JSON.parse(Buffer.concat(parts).toString())[0]).toEqual({
          userId: 3,
          displayName: '雪 "1"',
          email: null,
          enabled: true,
          score: 1.5,
        });
      }
    } finally {
      archive.close();
    }
    expect((await stream.result).bytesWritten).toBe(bytes.length);
  },
);

it("forwards cancellation while a declared query waits for a slow destination", async () => {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = callback;
      controller.abort();
    },
  });
  await expect(
    exportQuery(db, {
      sql: "SELECT * FROM users",
      columns,
      output,
      signal: controller.signal,
      bufferSize: 1,
    }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  release?.();
  expect(db.prepare("SELECT 1").pluck().get()).toBe(1);
  expect(output.listenerCount("error")).toBe(0);
  output.destroy();
});

it("releases an unused declared readable without executing its query", async () => {
  let executions = 0;
  const connection: SQLiteConnection = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        executions++;
        yield* iterate(...params);
      };
      return statement;
    },
  };
  const stream = await exportQuery(connection, {
    sql: "SELECT * FROM users",
    columns,
  });
  await stream.cancel();
  await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
  expect(executions).toBe(0);
});

it.each([
  "PRAGMA user_version=7",
  "DELETE FROM users RETURNING id",
  "SELECT id FROM users; SELECT 2",
  "SELECT id FROM users) SELECT 1; DELETE FROM users; --",
])("preserves the single read-only query restriction for %s", async (sql) => {
  await expect(
    exportQuery(db, { sql, columns: { id: integer() } }),
  ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(513);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
});

it.each([{}, { id: "number" }, { id: { type: "number" } }, [], new Map()])(
  "rejects invalid declarations %# before preparing a query",
  async (invalid) => {
    const connection: SQLiteConnection = {
      prepare() {
        throw new Error("Must reject before prepare");
      },
    };
    await expect(
      exportQuery(connection, {
        sql: "SELECT 1 AS id",
        columns: invalid as SelectedColumns,
      }),
    ).rejects.toHaveProperty("code");
  },
);

it("keeps nullable builders immutable and fails invalid SQLite boolean values", async () => {
  const nullable = text("email");
  const required = nullable.notNull();
  expect(nullable.required).toBe(false);
  expect(required.required).toBe(true);
  expect(Object.isFrozen(nullable)).toBe(true);
  expect(() => text("")).toThrow();
  expect(() => integer({ mode: "timestamp" } as never)).toThrow();
  expect(() => integer(null as never)).toThrow();
  db.exec("UPDATE users SET active=NULL WHERE id=3");
  const stream = await exportQuery(db, {
    sql: "SELECT active FROM users WHERE id=3",
    columns: { active: integer({ mode: "boolean" }) },
    format: "json",
  });
  expect(await new Response(stream).json()).toEqual([{ active: null }]);
  await stream.result;
  const failed = await exportQuery(db, {
    sql: "SELECT 2 AS active",
    columns: { active: integer({ mode: "boolean" }) },
    format: "json",
  });
  await expect(new Response(failed).text()).rejects.toThrow();
  await expect(failed.result).rejects.toMatchObject({ code: "SQLITE_ERROR" });
});
