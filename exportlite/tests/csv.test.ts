import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as remoteDrizzle } from "drizzle-orm/libsql/http";
import {
  integer as int,
  sqliteTable,
  text as str,
} from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, expect, expectTypeOf, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import * as adapter from "../src/drizzle.js";
import {
  type ExportRow,
  exportQuery,
  exportTable,
  integer,
  text,
} from "../src/index.js";
import * as remote from "../src/turso.js";
import { stalledProduction } from "./helpers/production.js";
import { tursoServer } from "./helpers/turso-server.js";

let db: Database.Database;
let server: Awaited<ReturnType<typeof tursoServer>>;
let client: ReturnType<typeof remote.createClient>;
let directory: string;
const selection = {
  userId: integer("id").primaryKey(),
  label: text("name"),
  payload: text("note"),
  active: integer({ mode: "boolean" }),
};
const table = sqliteTable("users", {
  userId: int("id").primaryKey(),
  label: str("name"),
  payload: str("note"),
  active: int({ mode: "boolean" }),
});
const expected = [
  {
    userId: "-3",
    label: 'Jóe 雪, "hi"\r\nnew',
    payload: "=1+1",
    active: "true",
  },
  { userId: "8", label: "", payload: "", active: "false" },
  { userId: "19", label: "", payload: '\0before"after\0end', active: "" },
  {
    userId: "9007199254740993",
    label: " test ",
    payload: "a,b\nc\rd\tend",
    active: "true",
  },
];
beforeEach(async () => {
  db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,note TEXT,active INTEGER)",
  );
  const insert = db.prepare("INSERT INTO users VALUES(?,?,?,?)");
  insert.run(-3, expected[0]?.label, expected[0]?.payload, 1);
  insert.run(8, "", null, 0);
  insert.run(19, null, expected[2]?.payload, null);
  insert.run(9007199254740993n, " test ", expected[3]?.payload, 1);
  server = await tursoServer(db);
  client = remote.createClient({ url: server.url });
  directory = await mkdtemp(join(tmpdir(), "exportlite-csv-"));
});
afterEach(async () => {
  await client.close().catch(() => {});
  await server.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

async function decodeZip(bytes: Buffer, name: string) {
  const zip = await fromBufferPromise(bytes);
  try {
    expect(zip.entryCount).toBe(1);
    for await (const entry of zip.eachEntry()) {
      expect(entry.fileName).toBe(name);
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(chunk);
      const content = Buffer.concat(chunks);
      expect(crc32(content)).toBe(entry.crc32);
      return content.toString("utf8");
    }
  } finally {
    zip.close();
  }
  throw Error("Missing ZIP entry");
}

it.each(["native", "drizzle", "turso", "drizzle-turso"])(
  "exports parsed CSV tables and ordered queries through %s, plain and ZIP",
  async (mode) => {
    const remoteMode = mode.includes("turso");
    const adapterMode = mode.includes("drizzle");
    const orm = remoteMode ? remoteDrizzle(client) : drizzle(db);
    for (const zip of [false, true])
      for (const query of [false, true]) {
        const options = { format: "csv" as const, zip };
        const stream = adapterMode
          ? query
            ? await adapter.exportQuery(
                orm,
                orm.select().from(table).orderBy(table.userId),
                options,
              )
            : await adapter.exportTable(orm, table, options)
          : remoteMode
            ? query
              ? await remote.exportQuery(client, {
                  ...options,
                  sql: "SELECT * FROM users ORDER BY id",
                  columns: selection,
                })
              : await remote.exportTable(client, "users", {
                  ...options,
                  columns: selection,
                })
            : query
              ? await exportQuery(db, {
                  ...options,
                  sql: "SELECT * FROM users ORDER BY id",
                  columns: selection,
                })
              : await exportTable(db, "users", {
                  ...options,
                  columns: selection,
                });
        const bytes = Buffer.from(await new Response(stream).arrayBuffer());
        const content = zip
          ? await decodeZip(bytes, query ? "export.csv" : "users.csv")
          : bytes.toString("utf8");
        expect(
          content.startsWith('"userId","label","payload","active"\r\n'),
        ).toBe(true);
        expect(content.endsWith("\r\n")).toBe(true);
        expect(parse(content, { columns: true })).toEqual(expected);
        expect(await stream.result).toMatchObject({
          rowsExported: 4,
          bytesWritten: bytes.length,
        });
      }
    if (remoteMode) {
      expect(server.cursors).toBe(4);
      expect(server.statements).toHaveLength(4);
      expect(
        server.requests.every((request) => request.path === "/v3/cursor"),
      ).toBe(true);
    }
  },
);

it.each([0, 1, 255, 256, 257, 513])(
  "keeps headers and row counts at the %i-row batch boundary",
  async (count) => {
    db.exec("DELETE FROM users");
    if (count)
      db.prepare(
        `WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<@count) INSERT INTO users SELECT x,'a,"b',NULL,1 FROM n`,
      ).run({ count });
    const statements: string[] = [];
    const traced = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
    };
    const stream = await exportTable(traced, "users", {
      columns: selection,
      format: "csv",
    });
    const content = await new Response(stream).text();
    expect(parse(content, { columns: true })).toHaveLength(count);
    expect((await stream.result).rowsExported).toBe(count);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WITH RECURSIVE "__exportlite_batches"');
    expect(
      content.split('"userId","label","payload","active"\r\n'),
    ).toHaveLength(2);
  },
);

it("discovers headers, invalidates cached schemas and keeps JSON/CSV plans separate", async () => {
  const first = await exportTable(db, "users", {
    format: "csv",
    columns: ["id", "name"],
  });
  expect(parse(await new Response(first).text())[0]).toEqual(["id", "name"]);
  await first.result;
  db.exec('ALTER TABLE users ADD COLUMN "odd,name" TEXT DEFAULT \'a,"b\'');
  const second = await exportTable(db, "users", { format: "csv" });
  expect(parse(await new Response(second).text())[0]).toEqual([
    "id",
    "name",
    "note",
    "active",
    "odd,name",
  ]);
  await second.result;
  const json = await exportTable(db, "users", {
    format: "json",
    columns: ["name"],
  });
  expect(await new Response(json).json()).toEqual(
    expected.map((row) => ({
      name: row.label === "" && row.userId === "19" ? null : row.label,
    })),
  );
  await json.result;
});

it("preserves query aliases, bindings, order, limits, empty text and NULL cells", async () => {
  const stream = await exportQuery(db, {
    format: "csv",
    sql: 'SELECT name AS "A",note AS "a" FROM users WHERE id > ? ORDER BY id DESC LIMIT 2;',
    params: [0],
  });
  const rows = parse(await new Response(stream).text());
  expect(rows).toEqual([
    ["A", "a"],
    [" test ", expected[3]?.payload],
    ["", expected[2]?.payload],
  ]);
  await stream.result;
  const onlyNull = await exportQuery(db, {
    format: "csv",
    sql: "SELECT NULL AS value",
  });
  expect(await new Response(onlyNull).text()).toBe('"value"\r\n\r\n');
  expect((await onlyNull.result).rowsExported).toBe(1);
});

it("evaluates computed query columns once and streams through a co-routine", async () => {
  let calls = 0;
  db.function("observed", () => BigInt(++calls));
  const statements: string[] = [];
  const traced = {
    prepare(sql: string) {
      statements.push(sql);
      return db.prepare(sql);
    },
  };
  const stream = await exportQuery(traced, {
    sql: "SELECT observed() AS value FROM users ORDER BY id",
    format: "csv",
    columns: { value: integer() },
  });
  expect(parse(await new Response(stream).text(), { columns: true })).toEqual(
    [1, 2, 3, 4].map((value) => ({ value: String(value) })),
  );
  await stream.result;
  expect(calls).toBe(4);
  expect(statements).toHaveLength(1);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all() as {
    detail: string;
  }[];
  expect(plan.some((row) => row.detail.includes("CO-ROUTINE"))).toBe(true);
  expect(plan.some((row) => row.detail.includes("MATERIALIZE"))).toBe(false);
});

it("escapes header aliases and supports views, WITHOUT ROWID tables and explicit rowid selections", async () => {
  const heading = 'label,"quoted"\r\nline';
  const aliased = await exportTable(db, "users", {
    columns: { [heading]: text("name") },
    format: "csv",
  });
  expect(parse(await new Response(aliased).text())[0]).toEqual([heading]);
  await aliased.result;
  db.exec(
    "CREATE TABLE codes(code TEXT PRIMARY KEY,note TEXT) WITHOUT ROWID; INSERT INTO codes VALUES('A','a,b'); CREATE VIEW view_codes AS SELECT code,note FROM codes",
  );
  for (const source of ["codes", "view_codes"]) {
    const stream = await exportTable(db, source, { format: "csv" });
    expect(parse(await new Response(stream).text(), { columns: true })).toEqual(
      [{ code: "A", note: "a,b" }],
    );
    await stream.result;
  }
  const stream = await exportTable(db, "users", {
    columns: { key: integer("rowid"), label: text("name") },
    format: "csv",
  });
  expect(parse(await new Response(stream).text(), { columns: true })).toEqual(
    expected.map((row) => ({ key: row.userId, label: row.label })),
  );
  await stream.result;
});

it.each([false, true])(
  "cancels a remote CSV query and reuses the client afterwards (zip=%s)",
  async (zip) => {
    const values = Array.from({ length: 16 }, () =>
      randomBytes(12_000).toString("base64"),
    );
    let calls = 0;
    db.function("observed", () => values[++calls % values.length] as string);
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const signal = new AbortController();
    const pending = remote.exportQuery(client, {
      sql: "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT observed() AS note FROM n",
      columns: { note: text() },
      format: "csv",
      output,
      zip,
      signal: signal.signal,
    });
    const failed = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    try {
      expect(await stalledProduction(() => calls)).toBeLessThan(2000);
    } finally {
      signal.abort();
      release?.();
      await failed;
    }
    expect(output.destroyed).toBe(false);
    const next = await remote.exportQuery(client, {
      sql: "SELECT 'ready' AS note",
      columns: { note: text() },
      format: "csv",
    });
    expect(parse(await new Response(next).text(), { columns: true })).toEqual([
      { note: "ready" },
    ]);
    await next.result;
  },
);

it("formats Drizzle JSON and boolean cells while keeping CSV types string-valued", async () => {
  db.exec(
    'ALTER TABLE users ADD COLUMN metadata TEXT; UPDATE users SET metadata=\' {"tags":["雪","a,b"]} \'',
  );
  const schema = sqliteTable("users", {
    id: int().primaryKey(),
    active: int({ mode: "boolean" }),
    metadata: str({ mode: "json" }).$type<{ tags: string[] }>(),
  });
  const stream = await adapter.exportTable(drizzle(db), schema, {
    format: "csv",
  });
  expectTypeOf<ExportRow<typeof stream>>().toEqualTypeOf<{
    id: string;
    active: string;
    metadata: string;
  }>();
  const rows = parse(await new Response(stream).text(), { columns: true });
  expect(rows[0]).toEqual({
    id: "-3",
    active: "true",
    metadata: '{"tags":["雪","a,b"]}',
  });
  await stream.result;
  const direct = await exportTable(db, "users", {
    columns: selection,
    format: "csv",
  });
  expectTypeOf<ExportRow<typeof direct>>().toEqualTypeOf<{
    userId: string;
    label: string;
    payload: string;
    active: string;
  }>();
  await direct.cancel();
});

it.each([false, true])(
  "cleans owned CSV files after BLOB or boolean failures (zip=%s)",
  async (zip) => {
    for (const invalid of [
      "UPDATE users SET name=x'00FF' WHERE id=-3",
      "UPDATE users SET name='ok',active=2 WHERE id=-3",
    ]) {
      db.exec(invalid);
      await expect(
        exportTable(db, "users", {
          columns: selection,
          format: "csv",
          output: join(directory, "failed.csv"),
          zip,
          bufferSize: 1,
        }),
      ).rejects.toMatchObject({ code: "SQLITE_ERROR" });
      expect(await readdir(directory)).toEqual([]);
    }
  },
);

it.each(["utf16le", "utf16be"] as const)(
  "exports CSV from %s without metadata probes",
  async (encoding) => {
    const other = new Database(":memory:");
    try {
      other.exec(
        `PRAGMA encoding='${encoding === "utf16le" ? "UTF-16le" : "UTF-16be"}'; CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'雪,""')`,
      );
      const columns = { id: integer().primaryKey(), name: text() };
      const wrong = await exportTable(other, "users", {
        columns,
        format: "csv",
      });
      await expect(new Response(wrong).text()).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
      const stream = await exportTable(other, "users", {
        columns,
        format: "csv",
        encoding,
      });
      expect(
        parse(await new Response(stream).text(), { columns: true }),
      ).toEqual([{ id: "1", name: '雪,""' }]);
      await stream.result;
    } finally {
      other.close();
    }
  },
);

it("preserves a leading NUL in a single text column across table batches", async () => {
  const payload = '\0first"after\0last';
  db.exec("DELETE FROM users");
  db.prepare(
    "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<257) INSERT INTO users SELECT x,NULL,?,NULL FROM n",
  ).run(payload);
  const stream = await exportTable(db, "users", {
    format: "csv",
    columns: { payload: text("note"), id: integer().primaryKey() },
  });
  expect(parse(await new Response(stream).text(), { columns: true })).toEqual(
    Array.from({ length: 257 }, (_, i) => ({ payload, id: String(i + 1) })),
  );
  await stream.result;
  const discovered = await exportTable(db, "users", {
    format: "csv",
    columns: ["note"],
  });
  expect(
    parse(await new Response(discovered).text(), { columns: true }),
  ).toEqual(Array.from({ length: 257 }, () => ({ note: payload })));
  await discovered.result;
});

it.each([false, true])(
  "supports parameterized raw Drizzle CSV selections (remote=%s)",
  async (network) => {
    const orm = network ? remoteDrizzle(client) : drizzle(db);
    const stream = await adapter.exportQuery(
      orm,
      sql`SELECT id,name FROM users WHERE id = ${8}`,
      { format: "csv", columns: { userId: table.userId, label: table.label } },
    );
    expectTypeOf<ExportRow<typeof stream>>().toEqualTypeOf<{
      userId: string;
      label: string;
    }>();
    expect(parse(await new Response(stream).text(), { columns: true })).toEqual(
      [{ userId: "8", label: "" }],
    );
    await stream.result;
  },
);

it.each([false, true])(
  "keeps CSV and CSV ZIP backpressure bounded and cancellation awaitable (zip=%s)",
  async (zip) => {
    const values = Array.from({ length: 16 }, () =>
      randomBytes(12_000).toString("base64"),
    );
    let calls = 0;
    db.function("observed", () => values[++calls % values.length] as string);
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const signal = new AbortController();
    const pending = exportQuery(db, {
      sql: "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT observed() AS note FROM n",
      format: "csv",
      output,
      signal: signal.signal,
      zip,
    });
    const failed = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    try {
      const count = await stalledProduction(() => calls);
      expect(count).toBeLessThan(500);
    } finally {
      signal.abort();
      release?.();
      await failed;
    }
    expect(output.destroyed).toBe(false);
    db.prepare("SELECT 1").get();
  },
);

it("writes exact UTF-8 file statistics and cancels an unused CSV stream without executing SQL", async () => {
  let calls = 0;
  db.function("observed", () => ++calls);
  const stream = await exportQuery(db, {
    sql: "SELECT observed() AS value FROM users",
    columns: { value: integer() },
    format: "csv",
  });
  await stream.cancel();
  await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
  expect(calls).toBe(0);
  const path = join(directory, "users.csv");
  const stats = await exportTable(db, "users", {
    columns: selection,
    format: "csv",
    output: path,
  });
  const bytes = await readFile(path);
  expect(stats.bytesWritten).toBe(bytes.length);
  expect(parse(bytes, { columns: true })).toEqual(expected);
});

it.each([false, true])(
  "waits for a later wide CSV batch write and cancels without closing the caller's output (zip=%s)",
  async (zip) => {
    db.exec("DELETE FROM users");
    const values = Array.from({ length: 16 }, () =>
      randomBytes(3_000).toString("base64"),
    );
    const insert = db.prepare("INSERT INTO users VALUES(?,NULL,?,NULL)");
    db.transaction(() => {
      for (let id = 1; id <= 2048; id++)
        insert.run(id, values[id % values.length]);
    })();
    let batches = 0;
    const traced = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* (...args) {
          for (const row of iterate(...args)) {
            batches++;
            yield row;
          }
        };
        return statement;
      },
    };
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        if (batches >= 2) release = callback;
        else setImmediate(callback);
      },
    });
    const signal = new AbortController();
    const pending = exportTable(traced, "users", {
      columns: selection,
      format: "csv",
      zip,
      output,
      signal: signal.signal,
    });
    const failed = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    try {
      const stopped = await stalledProduction(() =>
        batches >= 2 ? batches : 0,
      );
      expect(stopped).toBeGreaterThanOrEqual(2);
      expect(stopped).toBeLessThan(8);
    } finally {
      signal.abort();
      release?.();
      await failed;
    }
    expect(output.destroyed).toBe(false);
    expect(output.writableEnded).toBe(false);
    db.prepare("SELECT 1").get();
  },
);

it("keeps one empty CSV cell per NULL row across batch boundaries", async () => {
  db.exec(
    "DELETE FROM users; WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<257) INSERT INTO users SELECT x,NULL,NULL,NULL FROM n",
  );
  const stream = await exportTable(db, "users", {
    format: "csv",
    columns: ["note"],
  });
  const content = await new Response(stream).text();
  expect(content).toBe(`"note"\r\n${"\r\n".repeat(257)}`);
  expect(parse(content, { columns: true })).toHaveLength(257);
  expect((await stream.result).rowsExported).toBe(257);
});
