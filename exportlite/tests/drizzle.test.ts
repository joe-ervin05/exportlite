import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  blob,
  customType,
  integer,
  numeric,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import { exportQuery, exportTable } from "../src/drizzle.js";

const users = sqliteTable("users", {
  id: integer().primaryKey(),
  displayName: text("name").notNull(),
  email: text(),
  active: integer({ mode: "boolean" }).notNull(),
  score: real(),
  metadata: text({ mode: "json" }).$type<{ tags: string[] }>(),
});
let client: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  client = new Database(":memory:");
  client.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT,active INTEGER NOT NULL,score REAL,metadata TEXT)",
  );
  db = drizzle(client);
  db.transaction((tx) => {
    for (let i = 1; i <= 513; i++)
      tx.insert(users)
        .values({
          id: i * 3,
          displayName: `雪 "${i}"`,
          active: i % 2 === 1,
          metadata: i % 2 ? { tags: ["one", "雪"] } : null,
        })
        .run();
  });
});
afterEach(() => client.close());

function traced() {
  const prepared: string[] = [];
  const batches: number[] = [];
  let rows = 0;
  const proxy = new Proxy(client, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          prepared.push(query);
          const statement = target.prepare(query);
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...params) {
            for (const value of iterate(...params)) {
              rows++;
              if (Array.isArray(value)) batches.push(Number(value[1]));
              yield value;
            }
          };
          for (const method of ["get", "all", "columns"] as const)
            statement[method] = () => {
              throw new Error("No metadata or materialized rows permitted");
            };
          return statement;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: drizzle(proxy), prepared, batches, rows: () => rows };
}

it.each(["json", "jsonl"] as const)(
  "reuses schema keys, modes and an unselected primary key in %s batches",
  async (format) => {
    const trace = traced();
    const columns = {
      label: users.displayName,
      again: users.displayName,
      enabled: users.active,
      metadata: users.metadata,
    };
    for (let round = 0; round < 2; round++) {
      const stream = await exportTable(trace.db, users, { columns, format });
      expect(trace.rows()).toBe(round * 3);
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
        label: '雪 "1"',
        again: '雪 "1"',
        enabled: true,
        metadata: { tags: ["one", "雪"] },
      });
      expect(rows[1].metadata).toBeNull();
      expect((await stream.result).rowsExported).toBe(513);
    }
    expect(trace.prepared).toHaveLength(2);
    expect(trace.batches).toEqual([256, 256, 1, 256, 256, 1]);
    expect(trace.prepared.join("\n")).not.toMatch(
      /pragma|sqlite_schema|sqlite_version/i,
    );
  },
);

it("exports every Drizzle field by default, using property keys as JSON keys", async () => {
  const stream = await exportTable(db, users, { format: "json" });
  const rows = (await new Response(stream).json()) as unknown[];
  expect(rows[0]).toEqual({
    id: 3,
    displayName: '雪 "1"',
    email: null,
    active: true,
    score: null,
    metadata: { tags: ["one", "雪"] },
  });
  await stream.result;
});

it("compiles a select without executing Drizzle or probing its result metadata", async () => {
  const trace = traced();
  const query = trace.db
    .select({
      renamed: users.displayName,
      id: users.id,
      active: users.active,
      metadata: users.metadata,
      upper: sql<string>`upper(${users.displayName})`.as("uppercase"),
    })
    .from(users)
    .where(gt(users.id, 3))
    .orderBy(users.id)
    .limit(2);
  query.all = () => {
    throw new Error("Must not execute the Drizzle row mapper");
  };
  const stream = await exportQuery(trace.db, query, { format: "json" });
  expect(trace.prepared).toHaveLength(1);
  expect(trace.rows()).toBe(0);
  expect(await new Response(stream).json()).toEqual([
    {
      renamed: '雪 "2"',
      id: 6,
      active: false,
      metadata: null,
      upper: '雪 "2"',
    },
    {
      renamed: '雪 "3"',
      id: 9,
      active: true,
      metadata: { tags: ["one", "雪"] },
      upper: '雪 "3"',
    },
  ]);
  await stream.result;
  expect(trace.rows()).toBe(2);
});

it("keeps bindings parameterized, including Drizzle's parameter encoders", async () => {
  const attack = "x'); DROP TABLE users;--";
  const query = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.displayName, attack));
  const stream = await exportQuery(db, query, { format: "json" });
  expect(await new Response(stream).json()).toEqual([]);
  await stream.result;
  const booleans = await exportQuery(
    db,
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.active, true))
      .limit(1),
    { format: "json" },
  );
  expect(await new Response(booleans).json()).toEqual([{ id: 3 }]);
  await booleans.result;
  expect(client.prepare("SELECT count(*) AS n FROM users").get()).toEqual({
    n: 513,
  });
});

it("supports raw sql templates with schema columns and output aliases", async () => {
  const trace = traced();
  const stream = await exportQuery(
    trace.db,
    sql`SELECT * FROM ${users} WHERE ${users.id} > ${3} ORDER BY ${users.id} LIMIT ${1}`,
    {
      columns: {
        userId: users.id,
        enabled: users.active,
        data: users.metadata,
      },
      format: "json",
    },
  );
  expect(await new Response(stream).json()).toEqual([
    { userId: 6, enabled: false, data: null },
  ]);
  await stream.result;
  expect(trace.prepared).toHaveLength(1);
});

it("preserves flat left joins and repeated column names positionally", async () => {
  const pets = sqliteTable("pets", {
    id: integer().primaryKey(),
    owner: integer(),
    name: text(),
  });
  client.exec(
    "CREATE TABLE pets(id INTEGER PRIMARY KEY,owner INTEGER,name TEXT); INSERT INTO pets VALUES(7,3,'cat')",
  );
  const query = db
    .select({ id: users.id, petId: pets.id, label: pets.name })
    .from(users)
    .leftJoin(pets, eq(users.id, pets.owner))
    .orderBy(users.id)
    .limit(2);
  const stream = await exportQuery(db, query, { format: "json" });
  expect(await new Response(stream).json()).toEqual([
    { id: 3, petId: 7, label: "cat" },
    { id: 6, petId: null, label: null },
  ]);
  await stream.result;
});

it("reuses Drizzle's configured snake_case names for tables, selects and raw SQL", async () => {
  const table = sqliteTable("cased", {
    rowId: integer().primaryKey(),
    displayName: text().notNull(),
  });
  client.exec(
    "CREATE TABLE cased(row_id INTEGER PRIMARY KEY,display_name TEXT); INSERT INTO cased VALUES(1,'snake')",
  );
  const cased = drizzle(client, { casing: "snake_case" });
  for (const stream of [
    await exportTable(cased, table, { format: "json" }),
    await exportQuery(cased, cased.select().from(table), { format: "json" }),
    await exportQuery(cased, sql`SELECT * FROM ${table}`, {
      columns: { rowId: table.rowId, displayName: table.displayName },
      format: "json",
    }),
  ]) {
    expect(await new Response(stream).json()).toEqual([
      { rowId: 1, displayName: "snake" },
    ]);
    await stream.result;
  }
});

it.each(["composite", "text", "missing"])(
  "streams without integer-key batching for a %s primary key",
  async (kind) => {
    const table =
      kind === "composite"
        ? sqliteTable("other", { id: integer(), part: integer() }, (t) => [
            primaryKey({ columns: [t.id, t.part] }),
          ])
        : kind === "text"
          ? sqliteTable("other", { id: text().primaryKey(), part: integer() })
          : sqliteTable("other", { id: integer(), part: integer() });
    client.exec(
      `CREATE TABLE other(id ${kind === "text" ? "TEXT" : "INTEGER"},part INTEGER); INSERT INTO other VALUES(1,1),(1,2)`,
    );
    const trace = traced();
    const stream = await exportTable(trace.db, table, {
      columns: { part: table.part },
      format: "json",
    });
    expect(await new Response(stream).json()).toEqual([
      { part: 1 },
      { part: 2 },
    ]);
    await stream.result;
    expect(trace.prepared).toHaveLength(1);
    expect(trace.prepared[0]).not.toMatch(/RECURSIVE/i);
    expect(trace.batches).toEqual([]);
  },
);

it("uses a single-column table-level primary key even when omitted from output", async () => {
  const table = sqliteTable(
    "users",
    { key: integer("id"), name: text() },
    (t) => [primaryKey({ columns: [t.key] })],
  );
  const trace = traced();
  const stream = await exportTable(trace.db, table, {
    columns: { label: table.name },
  });
  await new Response(stream).arrayBuffer();
  await stream.result;
  expect(trace.batches).toEqual([256, 256, 1]);
});

it.each(["timestamp", "timestamp_ms", "blob", "custom", "numeric"])(
  "rejects %s JavaScript decoding before running an export",
  async (mode) => {
    const table = sqliteTable("unsupported", {
      field:
        mode === "timestamp" || mode === "timestamp_ms"
          ? integer({ mode })
          : mode === "blob"
            ? blob({ mode: "buffer" })
            : mode === "numeric"
              ? numeric()
              : customType<{ data: string }>({
                  dataType: () => "text",
                  fromDriver: (value) => String(value).toUpperCase(),
                })(),
    });
    const trace = traced();
    await expect(exportTable(trace.db, table)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringContaining("JavaScript decoder"),
    });
    await expect(
      exportQuery(trace.db, trace.db.select().from(table)),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(trace.prepared).toEqual([]);
  },
);

it("rejects nested selections, .mapWith() and unaliased expressions explicitly", async () => {
  const trace = traced();
  const nested = trace.db.select({ user: { id: users.id } }).from(users);
  await expect(exportQuery(trace.db, nested)).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
    message: expect.stringContaining("flat"),
  });
  const mapped = trace.db
    .select({
      name: sql`${users.displayName}`
        .mapWith((x) => String(x).toUpperCase())
        .as("name"),
    })
    .from(users);
  await expect(exportQuery(trace.db, mapped)).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
    message: expect.stringContaining(".mapWith()"),
  });
  const unaliased = trace.db
    .select({ upper: sql<string>`upper(${users.displayName})` })
    .from(users);
  await expect(exportQuery(trace.db, unaliased)).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
    message: expect.stringContaining(".as(...)"),
  });
  expect(trace.prepared).toEqual([]);
});

it("rejects unsupported drivers, foreign table columns and missing raw metadata", async () => {
  const foreign = sqliteTable("foreign", { id: integer() });
  await expect(
    exportTable(db, users, { columns: { id: foreign.id } }),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  // @ts-expect-error Raw SQL needs schema metadata rather than trusting a TS cast.
  await expect(exportQuery(db, sql`SELECT 1`)).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
  });
  await expect(exportTable({ $client: client }, users)).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
    message: expect.stringContaining("better-sqlite3"),
  });
});

it.each([sql`DELETE FROM users RETURNING id`, sql`PRAGMA user_version=42`])(
  "rejects raw writes without changing caller data",
  async (query) => {
    await expect(
      exportQuery(db, query, { columns: { id: users.id } }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(client.prepare("SELECT count(*) AS n FROM users").get()).toEqual({
      n: 513,
    });
    expect(client.pragma("user_version", { simple: true })).toBe(0);
  },
);

it.each(["esm", "cjs"])(
  "decodes a ZIP from the built %s adapter",
  async (kind) => {
    const built: typeof import("../src/drizzle.js") =
      kind === "esm"
        ? await import("../dist/drizzle.mjs")
        : createRequire(import.meta.url)("../dist/drizzle.cjs");
    const stream = await built.exportTable(db, users, {
      columns: { id: users.id, enabled: users.active },
      format: "json",
      zip: true,
    });
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    const archive = await fromBufferPromise(bytes);
    try {
      for await (const entry of archive.eachEntry()) {
        expect(entry.fileName).toBe("users.json");
        const parts: Buffer[] = [];
        for await (const chunk of await archive.openReadStreamPromise(entry))
          parts.push(chunk);
        const rows = JSON.parse(Buffer.concat(parts).toString("utf8"));
        expect(rows).toHaveLength(513);
        expect(rows[0]).toEqual({ id: 3, enabled: true });
      }
    } finally {
      archive.close();
    }
    expect((await stream.result).bytesWritten).toBe(bytes.length);
    const query = db
      .select({ label: sql<string>`upper(${users.displayName})`.as("upper") })
      .from(users)
      .limit(1);
    const response = await built.exportQuery(db, query, { format: "json" });
    expect(await new Response(response).json()).toEqual([{ label: '雪 "1"' }]);
    await response.result;
    const mapped = db
      .select({ label: sql`${users.displayName}`.mapWith(String).as("label") })
      .from(users);
    await expect(built.exportQuery(db, mapped)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  },
);

it.each([false, true])(
  "cancels a lazy stream (zip=%s) and keeps the database reusable",
  async (zip) => {
    const trace = traced();
    const first = await exportTable(trace.db, users, { zip });
    const second = await exportTable(trace.db, users);
    expect(trace.rows()).toBe(0);
    await first.cancel("unused");
    await expect(first.result).rejects.toMatchObject({ code: "ABORTED" });
    await new Response(second).arrayBuffer();
    expect((await second.result).rowsExported).toBe(513);
    expect(client.open).toBe(true);
  },
);

it.each([false, true])(
  "honors slow writable backpressure and abort cleanup (zip=%s)",
  async (zip) => {
    client.exec(
      "WITH RECURSIVE n(x) AS (VALUES(514) UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO users(id,name,active) SELECT x*3,hex(randomblob(512)),1 FROM n",
    );
    const trace = traced();
    const controller = new AbortController();
    let release: ((error?: Error | null) => void) | undefined;
    let wrote!: () => void;
    const blocked = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
        wrote();
      },
    });
    const pending = exportTable(trace.db, users, {
      output,
      bufferSize: 1,
      zip,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "ABORTED",
    });
    await blocked;
    try {
      // ZIP may emit its header before filling the bounded compression buffers.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const produced = trace.rows();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(trace.rows()).toBe(produced);
      expect(produced).toBeLessThan(32);
    } finally {
      controller.abort();
      release?.();
      await rejection;
    }
    expect(output.destroyed).toBe(false);
    client.prepare("SELECT 1").get();
  },
);

it("removes an owned partial ZIP after invalid JSON fails during iteration", async () => {
  const folder = await mkdtemp(join(tmpdir(), "exportlite-drizzle-"));
  client.exec("UPDATE users SET metadata='invalid json' WHERE id=1539");
  try {
    await expect(
      exportTable(db, users, { output: join(folder, "users.zip"), zip: true }),
    ).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    expect(await readdir(folder)).toEqual([]);
    expect(client.open).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it.each(["utf16le", "utf16be"] as const)(
  "preserves UTF-8 output from a declared %s database without probes",
  async (encoding) => {
    const native = new Database(":memory:");
    try {
      native.pragma(
        `encoding='${encoding === "utf16le" ? "UTF-16le" : "UTF-16be"}'`,
      );
      native.exec(
        "CREATE TABLE encoded(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO encoded VALUES(1,'雪 😀')",
      );
      const encoded = sqliteTable("encoded", {
        id: integer().primaryKey(),
        name: text(),
      });
      const wrapped = drizzle(native);
      const stream = await exportTable(wrapped, encoded, {
        encoding,
        format: "json",
      });
      expect(await new Response(stream).json()).toEqual([
        { id: 1, name: "雪 😀" },
      ]);
      await stream.result;
      const wrong = await exportTable(wrapped, encoded);
      await expect(new Response(wrong).text()).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
      await expect(wrong.result).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
    } finally {
      native.close();
    }
  },
);

it.each(["table", "query"])(
  "cancels an active %s cursor and releases the caller connection",
  async (kind) => {
    const stream =
      kind === "table"
        ? await exportTable(db, users, { bufferSize: 1 })
        : await exportQuery(db, db.select({ id: users.id }).from(users), {
            bufferSize: 1,
          });
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client disconnected");
    await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
    client.exec("UPDATE users SET name='reusable' WHERE id=3");
  },
);

it("prepares a fresh statement after schema changes, using only declared fields", async () => {
  const selection = { label: users.displayName };
  const first = await exportTable(db, users, { columns: selection });
  await first.cancel();
  client.exec(
    "ALTER TABLE users ADD COLUMN extra TEXT; UPDATE users SET name='fresh' WHERE id=3",
  );
  const second = await exportTable(db, users, {
    columns: selection,
    format: "json",
  });
  expect(((await new Response(second).json()) as unknown[])[0]).toEqual({
    label: "fresh",
  });
  await second.result;
  client.exec("ALTER TABLE users RENAME COLUMN name TO renamed");
  await expect(
    exportTable(db, users, { columns: selection }),
  ).rejects.toMatchObject({ code: "INVALID_QUERY" });
});

it("loads both core entry points without installing the optional Drizzle peer", async () => {
  const folder = await mkdtemp(join(tmpdir(), "exportlite-optional-peer-"));
  try {
    await cp(
      fileURLToPath(new URL("../dist", import.meta.url)),
      join(folder, "dist"),
      { recursive: true },
    );
    await mkdir(join(folder, "node_modules"));
    const require = createRequire(import.meta.url);
    await symlink(
      dirname(require.resolve("zip-stream")),
      join(folder, "node_modules/zip-stream"),
    );
    const esm = pathToFileURL(join(folder, "dist/index.mjs")).href;
    const cjs = join(folder, "dist/index.cjs");
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(esm)});
      let missing = false;
      try { require.resolve('drizzle-orm'); } catch { missing = true; }
      if (!missing) throw Error('Test fixture must not contain Drizzle');
      for (const entry of [await import(${JSON.stringify(esm)}), require(${JSON.stringify(cjs)})]) {
        if (typeof entry.exportTable !== 'function') throw Error('Missing export');
      }
      process.stdout.write('ok');
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "--eval",
      script,
    ]);
    expect(stdout).toBe("ok");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
