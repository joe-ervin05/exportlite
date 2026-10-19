import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql/http";
import {
  integer as int,
  primaryKey,
  sqliteTable,
  text as str,
} from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import {
  exportQuery as drizzleQuery,
  exportTable as drizzleTable,
} from "../src/drizzle.js";
import { integer, exportTable as localTable, text } from "../src/index.js";
import {
  createClient,
  exportQuery,
  exportTable,
  type TursoClient,
} from "../src/turso.js";
import { tursoServer } from "./helpers/turso-server.js";

async function consume(stream: Awaited<ReturnType<typeof exportTable>>) {
  const body = await new Response(stream as ReadableStream<Uint8Array>).text();
  await (stream as import("../src/types.js").ExportStream).result;
  return body;
}

const table = sqliteTable("users", {
  id: int().primaryKey(),
  name: str().notNull(),
  active: int({ mode: "boolean" }),
  metadata: str({ mode: "json" }).$type<{ tags: string[] }>(),
});
const columns = {
  id: integer().primaryKey(),
  label: text("name").notNull(),
  enabled: integer("active", { mode: "boolean" }),
};
let native: Database.Database;
let server: Awaited<ReturnType<typeof tursoServer>>;
let client: TursoClient;
beforeEach(async () => {
  native = new Database(":memory:");
  native.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER,metadata TEXT)",
  );
  const insert = native.prepare("INSERT INTO users VALUES(?,?,?,?)");
  native.transaction(() => {
    for (let i = 1; i <= 513; i++)
      insert.run(
        i * 3,
        `雪 😀 "${i}"`,
        i % 2,
        i % 2 ? '{"tags":["雪","one"]}' : null,
      );
  })();
  server = await tursoServer(native);
  client = createClient({
    url: server.url,
    authToken: "test-token",
    remoteEncryptionKey: "test-encryption-key",
  });
});
afterEach(async () => {
  await client?.close().catch(() => {});
  await server?.close();
  native?.close();
});

it.each(["json", "jsonl"] as const)(
  "streams fixed %s batches over one cursor query, with no preflight",
  async (format) => {
    const stream = await exportTable(client, "users", { columns, format });
    expect(server.requests).toEqual([]);
    const body = await new Response(stream).text();
    const rows =
      format === "json"
        ? JSON.parse(body)
        : body
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(513);
    expect(rows[0]).toEqual({ id: 3, label: '雪 😀 "1"', enabled: true });
    expect(server.batches).toEqual([256, 256, 1]);
    expect((await stream.result).rowsExported).toBe(513);
    expect(server.requests.map((request) => request.path)).toEqual([
      "/v3/cursor",
    ]);
    expect(server.statements).toHaveLength(1);
    expect(server.statements[0]).not.toMatch(
      /pragma|sqlite_schema|sqlite_version/i,
    );
    expect(server.statements[0]).not.toMatch(/AS BLOB/i);
    expect(server.requests[0]?.authorization).toBe("Bearer test-token");
    expect(server.requests[0]?.encryption).toBe("test-encryption-key");
    expect(server.sessions).toBe(1);
    expect(client.closed).toBe(false);
    await client.close();
    expect(server.sessions).toBe(0);
  },
);

it.each([0, 1, 255, 256, 257, 512, 513])(
  "matches local bytes for %i records",
  async (size) => {
    native.exec(`DELETE FROM users WHERE id>${size * 3}`);
    const local = await localTable(native, "users", {
      columns,
      format: "json",
    });
    const expected = await new Response(local).text();
    await local.result;
    const remote = await exportTable(client, "users", {
      columns,
      format: "json",
    });
    expect(await new Response(remote).text()).toBe(expected);
    expect((await remote.result).rowsExported).toBe(size);
  },
);

it("reuses Drizzle schema JSON/boolean modes and an unselected primary key", async () => {
  const db = drizzle(client);
  const stream = await drizzleTable(db, table, {
    columns: { label: table.name, enabled: table.active, data: table.metadata },
    format: "json",
  });
  expect(server.requests).toHaveLength(0);
  const rows = (await new Response(stream).json()) as unknown[];
  expect(rows[0]).toEqual({
    label: '雪 😀 "1"',
    enabled: true,
    data: { tags: ["雪", "one"] },
  });
  expect(rows[1]).toEqual({ label: '雪 😀 "2"', enabled: false, data: null });
  await stream.result;
  expect(server.batches).toEqual([256, 256, 1]);
  expect(server.statements).toHaveLength(1);
});

it("reuses one rotating session for direct and Drizzle table/query exports", async () => {
  const db = drizzle(client);
  await consume(
    await exportTable(client, "users", { columns, format: "json" }),
  );
  await consume(await drizzleTable(db, table, { format: "json" }));
  await consume(
    await exportQuery(client, {
      sql: "SELECT id FROM users LIMIT 1",
      columns: { id: integer() },
      format: "json",
    }),
  );
  await consume(
    await drizzleQuery(db, db.select({ id: table.id }).from(table).limit(1), {
      format: "json",
    }),
  );
  expect(server.requests.map((r) => r.path)).toEqual(
    Array(4).fill("/v3/cursor"),
  );
  expect(server.requests[0]?.body.baton).toBe(null);
  const batons = server.requests.slice(1).map((r) => r.body.baton);
  expect(batons.every((b) => typeof b === "string")).toBe(true);
  expect(new Set(batons).size).toBe(3);
  expect(server.sessions).toBe(1);
  expect(server.statements).toHaveLength(4);
  await client.close();
  expect(server.sessions).toBe(0);
  expect(server.requests[4]?.path).toBe("/v3/pipeline");
});

it("serializes complete exports, including a slow destination", async () => {
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      if (!release) release = callback;
      else callback();
    },
  });
  const first = exportTable(client, "users", {
    columns,
    output,
    bufferSize: 1,
  });
  await until(() => release !== undefined);
  const stream = await drizzleTable(drizzle(client), table, { format: "json" });
  const second = consume(stream);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(server.cursors).toBe(1);
  release?.();
  await first;
  expect(JSON.parse(await second)).toHaveLength(513);
  expect(server.cursors).toBe(2);
  expect(server.requests[1]?.body.baton).toBeTypeOf("string");
});

it.each([false, true])(
  "cancels a queued readable without disturbing the active export (zip=%s)",
  async (zip) => {
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        if (!release) release = callback;
        else callback();
      },
    });
    const first = exportTable(client, "users", {
      columns,
      output,
      bufferSize: 1,
    });
    await until(() => release !== undefined);
    const queued = await exportTable(client, "users", { columns, zip });
    const reader = queued.getReader();
    const read = reader.read();
    await reader.cancel("skip queued export");
    await read;
    await expect(queued.result).rejects.toMatchObject({ code: "ABORTED" });
    expect(server.cursors).toBe(1);
    release?.();
    await first;
    await consume(await exportTable(client, "users", { columns }));
    expect(server.requests[1]?.body.baton).toBeTypeOf("string");
  },
);

it("closes active and queued exports while a destination is blocked", async () => {
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = callback;
    },
  });
  const active = exportTable(client, "users", {
    columns,
    output,
    bufferSize: 1,
  });
  const failed = expect(active).rejects.toMatchObject({ code: "ABORTED" });
  await until(() => release !== undefined);
  const queued = await exportTable(client, "users", { columns });
  const queuedBody = expect(new Response(queued).text()).rejects.toMatchObject({
    code: "ABORTED",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = client.close();
  expect(client.closed).toBe(true);
  expect(client.close()).toBe(closing);
  try {
    await closing;
    await failed;
    await queuedBody;
    await expect(queued.result).rejects.toMatchObject({ code: "ABORTED" });
  } finally {
    release?.();
  }
  expect(server.sessions).toBe(0);
  expect(server.cursors).toBe(1);
  expect(output.destroyed).toBe(false);
});

it("does not create a queued output file before acquiring the session", async () => {
  const folder = await mkdtemp(join(tmpdir(), "exportlite-queued-"));
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      if (!release) release = callback;
      else callback();
    },
  });
  const active = exportTable(client, "users", {
    columns,
    output,
    bufferSize: 1,
  });
  await until(() => release !== undefined);
  const abort = new AbortController();
  const queued = exportTable(client, "users", {
    columns,
    output: join(folder, "queued.zip"),
    zip: true,
    signal: abort.signal,
  });
  const failure = expect(queued).rejects.toMatchObject({ code: "ABORTED" });
  abort.abort();
  await failure;
  expect(await readdir(folder)).toEqual([]);
  release?.();
  await active;
  await rm(folder, { recursive: true, force: true });
});

it("waits for an acknowledged idle-session close and closes only once", async () => {
  await consume(await exportTable(client, "users", { columns }));
  let release!: () => void;
  server.mode.closeWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const closing = client.close();
  void closing.then(() => {
    settled = true;
  });
  await until(() => server.requests.length === 2);
  expect(settled).toBe(false);
  expect(server.sessions).toBe(1);
  release();
  await closing;
  await client.close();
  expect(server.requests).toHaveLength(2);
  expect(server.sessions).toBe(0);
});

it("reports shutdown failures without deleting a completed export", async () => {
  const folder = await mkdtemp(join(tmpdir(), "exportlite-close-error-"));
  try {
    await exportTable(client, "users", {
      columns,
      output: join(folder, "users.zip"),
      zip: true,
    });
    server.mode.closeError = true;
    await expect(client.close()).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
    expect(await readdir(folder)).toEqual(["users.zip"]);
    expect(client.closed).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("closes an unused client without network I/O", async () => {
  await client.close();
  expect(server.requests).toHaveLength(0);
});

it("reports a cleanup failure during active client shutdown", async () => {
  server.mode.hold = "body";
  const stream = await exportTable(client, "users", { columns });
  const body = expect(new Response(stream).text()).rejects.toMatchObject({
    code: "ABORTED",
  });
  await until(() => server.cursors === 1);
  server.mode.closeError = true;
  await expect(client.close()).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  await body;
  await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
});

it.each([false, true])(
  "recovers an expired cached session once before execution (legacy=%s)",
  async (legacy) => {
    await consume(await exportTable(client, "users", { columns }));
    server.mode.legacyExpiry = legacy;
    server.expireSessions();
    await consume(await exportTable(client, "users", { columns }));
    expect(server.cursors).toBe(3);
    expect(server.statements).toHaveLength(2);
    expect(server.requests[1]?.body.baton).toBeTypeOf("string");
    expect(server.requests[2]?.body.baton).toBe(null);
    expect(server.sessions).toBe(1);
  },
);

it.each([false, true])(
  "treats an expired idle session as already closed (legacy=%s)",
  async (legacy) => {
    await consume(await exportTable(client, "users", { columns }));
    server.mode.legacyExpiry = legacy;
    server.expireSessions();
    await expect(client.close()).resolves.toBeUndefined();
    expect(server.requests).toHaveLength(2);
  },
);

it("never retries a missing endpoint for a fresh session", async () => {
  server.mode.status = 404;
  await expect(
    consume(await exportTable(client, "users", { columns })),
  ).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  expect(server.cursors).toBe(1);
});

it("limits stale-session recovery to one fresh request", async () => {
  await consume(await exportTable(client, "users", { columns }));
  server.expireSessions();
  server.mode.status = 404;
  await expect(
    consume(await exportTable(client, "users", { columns })),
  ).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  expect(server.cursors).toBe(3);
  expect(server.statements).toHaveLength(1);
});

it.each([400, 401, 500])(
  "does not replay HTTP %i errors from a reused session",
  async (status) => {
    await consume(await exportTable(client, "users", { columns }));
    server.mode.status = status;
    await expect(
      consume(await exportTable(client, "users", { columns })),
    ).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    expect(server.cursors).toBe(2);
    expect(server.sessions).toBe(0);
    delete server.mode.status;
    await consume(await exportTable(client, "users", { columns }));
    expect(server.requests.at(-1)?.body.baton).toBe(null);
  },
);

it.each(["truncate", "sql-error"])(
  "discards a reused session after %s without replay",
  async (kind) => {
    await consume(await exportTable(client, "users", { columns }));
    if (kind === "truncate") server.mode.truncate = true;
    else server.mode.rowError = 1;
    await expect(
      consume(await exportTable(client, "users", { columns })),
    ).rejects.toMatchObject({
      code: kind === "truncate" ? "REMOTE_ERROR" : "SQLITE_ERROR",
    });
    expect(server.cursors).toBe(2);
    expect(server.statements).toHaveLength(2);
    expect(server.sessions).toBe(0);
    delete server.mode.truncate;
    delete server.mode.rowError;
    await consume(await exportTable(client, "users", { columns }));
    expect(server.requests.at(-1)?.body.baton).toBe(null);
  },
);

it("does not replay network failures on a cached session", async () => {
  let cursors = 0;
  const peer = createClient({
    url: server.url,
    fetch: async (input, init) => {
      if (String(input).endsWith("/cursor") && ++cursors === 2)
        throw new Error("network lost");
      return fetch(input, init);
    },
  });
  try {
    await consume(await exportTable(peer, "users", { columns }));
    await expect(
      consume(await exportTable(peer, "users", { columns })),
    ).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    expect(cursors).toBe(2);
    expect(server.sessions).toBe(0);
  } finally {
    await peer.close();
  }
});

it("accepts the modern cursor terminator and reuses its session", async () => {
  server.mode.terminator = true;
  await consume(await exportTable(client, "users", { columns }));
  await consume(await exportTable(client, "users", { columns }));
  expect(server.sessions).toBe(1);
  expect(server.cursors).toBe(2);
});

it("keeps different clients independent", async () => {
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      if (!release) release = callback;
      else callback();
    },
  });
  const first = exportTable(client, "users", {
    columns,
    output,
    bufferSize: 1,
  });
  await until(() => release !== undefined);
  const peer = createClient({ url: server.url });
  try {
    await consume(await exportTable(peer, "users", { columns }));
    expect(server.sessions).toBe(2);
  } finally {
    release?.();
    await first;
    await peer.close();
  }
});

it("reconnects after close with a fresh export session", async () => {
  await consume(await exportTable(client, "users", { columns }));
  await client.close();
  await client.reconnect();
  expect(client.closed).toBe(false);
  await consume(await exportTable(client, "users", { columns }));
  expect(server.requests.at(-1)?.body.baton).toBe(null);
});

it("lets close win over an in-flight reconnect", async () => {
  await consume(await exportTable(client, "users", { columns }));
  let release!: () => void;
  server.mode.closeWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconnect = client.reconnect();
  await until(() => server.requests.length === 2);
  const closing = client.close();
  release();
  await reconnect;
  await closing;
  expect(client.closed).toBe(true);
  expect(server.sessions).toBe(0);
});

it("compiles Drizzle selects with bindings without running its buffered executor", async () => {
  const db = drizzle(client);
  const query = db
    .select({ userId: table.id, label: table.name, enabled: table.active })
    .from(table)
    .where(gt(table.id, 3))
    .orderBy(table.id)
    .limit(2);
  query.all = () => {
    throw new Error("Do not execute buffered Drizzle results");
  };
  const stream = await drizzleQuery(db, query, { format: "json" });
  expect(await new Response(stream).json()).toEqual([
    { userId: 6, label: '雪 😀 "2"', enabled: false },
    { userId: 9, label: '雪 😀 "3"', enabled: true },
  ]);
  await stream.result;
  expect(server.statements).toHaveLength(1);
  expect(server.batches).toEqual([]);
  const bool = await drizzleQuery(
    db,
    db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.active, true))
      .limit(1),
    { format: "json" },
  );
  expect(await new Response(bool).json()).toEqual([{ id: 3 }]);
  await bool.result;
});

it("supports Drizzle raw SQL and the same schema-based output aliases", async () => {
  const stream = await drizzleQuery(
    drizzle(client),
    sql`SELECT * FROM ${table} WHERE ${table.id}=${3}`,
    {
      columns: { label: table.name, enabled: table.active },
      format: "json",
    },
  );
  expect(await new Response(stream).json()).toEqual([
    { label: '雪 😀 "1"', enabled: true },
  ]);
  await stream.result;
});

it("binds named arguments, signed integers, floating point values and binary data", async () => {
  const stream = await exportQuery(client, {
    sql: "SELECT @id id, @name name, @enabled active, hex(@bytes) encoded, @score score",
    params: {
      id: 9223372036854775807n,
      name: "x'); DROP TABLE users;--",
      enabled: 1,
      bytes: Buffer.from([0, 255]),
      score: 1.25,
    },
    columns: {
      id: integer(),
      name: text(),
      active: integer(),
      encoded: text(),
      score: integer(),
    },
    format: "json",
  });
  const body = await new Response(stream).text();
  expect(body).toContain('"id":9223372036854775807');
  expect(JSON.parse(body)[0]).toMatchObject({
    name: "x'); DROP TABLE users;--",
    encoded: "00FF",
    score: 1.25,
  });
  await stream.result;
  expect(native.prepare("SELECT count(*) n FROM users").get()).toEqual({
    n: 513,
  });
});

it.each(["missing", "composite", "text"])(
  "keeps the row fallback with a %s key",
  async (kind) => {
    native.exec(
      "CREATE TABLE fallback(id INTEGER,part INTEGER,name TEXT); INSERT INTO fallback VALUES(1,1,'a'),(1,2,'b')",
    );
    const schema =
      kind === "composite"
        ? sqliteTable(
            "fallback",
            { id: int(), part: int(), name: str() },
            (t) => [primaryKey({ columns: [t.id, t.part] })],
          )
        : kind === "text"
          ? sqliteTable("fallback", {
              id: str().primaryKey(),
              part: int(),
              name: str(),
            })
          : sqliteTable("fallback", { id: int(), part: int(), name: str() });
    const stream = await drizzleTable(drizzle(client), schema, {
      columns: { label: schema.name },
      format: "json",
    });
    expect(await new Response(stream).json()).toEqual([
      { label: "a" },
      { label: "b" },
    ]);
    await stream.result;
    expect(server.statements).toHaveLength(1);
    expect(server.statements[0]).not.toMatch(/RECURSIVE/);
  },
);

it.each([false, true])(
  "streams and independently decodes ZIP output (Drizzle=%s)",
  async (useDrizzle) => {
    const stream = useDrizzle
      ? await drizzleTable(drizzle(client), table, {
          columns: { id: table.id, label: table.name },
          format: "json",
          zip: true,
        })
      : await exportTable(client, "users", {
          columns: { id: columns.id, label: columns.label },
          format: "json",
          zip: true,
        });
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    const archive = await fromBufferPromise(bytes);
    try {
      expect(archive.entryCount).toBe(1);
      for await (const entry of archive.eachEntry()) {
        expect(entry.fileName).toBe("users.json");
        const parts: Buffer[] = [];
        for await (const chunk of await archive.openReadStreamPromise(entry))
          parts.push(chunk);
        expect(JSON.parse(Buffer.concat(parts).toString("utf8"))).toHaveLength(
          513,
        );
      }
    } finally {
      archive.close();
    }
    expect((await stream.result).bytesWritten).toBe(bytes.length);
    expect(server.sessions).toBe(1);
  },
);

it("decodes fragmented UTF-8 cursor frames", async () => {
  server.mode.fragment = 1;
  const stream = await exportQuery(client, {
    sql: "SELECT name FROM users LIMIT 1",
    columns: { label: text("name") },
    format: "json",
  });
  expect(await new Response(stream).json()).toEqual([{ label: '雪 😀 "1"' }]);
  await stream.result;
});

it.each([false, true])(
  "cancels an unused stream without issuing a request (zip=%s)",
  async (zip) => {
    const stream = await exportTable(client, "users", { columns, zip });
    await stream.cancel();
    await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
    expect(server.requests).toEqual([]);
  },
);

it.each(["headers", "body"] as const)(
  "aborts while awaiting remote %s and keeps the client reusable",
  async (hold) => {
    server.mode.hold = hold;
    const controller = new AbortController();
    const stream = await exportTable(client, "users", {
      columns,
      signal: controller.signal,
    });
    const pending = new Response(stream).text();
    const error = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await until(() => server.cursors === 1);
    controller.abort();
    await error;
    await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
    expect(client.closed).toBe(false);
    expect(server.sessions).toBe(0);
    delete server.mode.hold;
    const again = await exportTable(client, "users", { columns });
    await new Response(again).arrayBuffer();
    await again.result;
  },
);

it.each([false, true])(
  "stops an active read when its reader is cancelled (zip=%s)",
  async (zip) => {
    const stream = await exportTable(client, "users", {
      columns,
      zip,
      bufferSize: 1,
    });
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("disconnected");
    await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
    expect(client.closed).toBe(false);
    expect(server.sessions).toBe(0);
  },
);

it.each([false, true])(
  "preserves backpressure and aborts a blocked destination (zip=%s)",
  async (zip) => {
    native.exec(
      "WITH RECURSIVE n(x) AS(VALUES(514) UNION ALL SELECT x+1 FROM n WHERE x<16384) INSERT INTO users(id,name,active) SELECT x*3,hex(randomblob(512)),1 FROM n",
    );
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const pending = exportTable(client, "users", {
      columns,
      output,
      bufferSize: 1,
      zip,
      signal: controller.signal,
    });
    const failure = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    try {
      await until(() => release !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const produced = server.produced;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(server.produced).toBe(produced);
      expect(produced).toBeLessThan(64);
    } finally {
      controller.abort();
      release?.();
      await failure;
    }
    expect(output.destroyed).toBe(false);
    expect(server.sessions).toBe(0);
  },
);

it("interrupts a pending remote read when the destination fails", async () => {
  server.mode.hold = "body";
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const pending = exportTable(client, "users", { columns, output });
  const failure = expect(pending).rejects.toMatchObject({
    code: "OUTPUT_ERROR",
  });
  await until(() => server.cursors === 1);
  output.emit("error", new Error("connection lost"));
  await failure;
  expect(server.sessions).toBe(0);
});

it("cancels active exports when the caller closes the official client", async () => {
  server.mode.hold = "body";
  const stream = await exportTable(client, "users", { columns });
  const failure = expect(new Response(stream).text()).rejects.toMatchObject({
    code: "ABORTED",
  });
  await until(() => server.cursors === 1);
  client.close();
  await failure;
  await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
});

it.each(["truncate", "sql-error", "http-error"])(
  "cleans up owned files on %s",
  async (kind) => {
    const folder = await mkdtemp(join(tmpdir(), "exportlite-turso-"));
    if (kind === "truncate") server.mode.truncate = true;
    if (kind === "sql-error") server.mode.rowError = 1;
    if (kind === "http-error") server.mode.status = 401;
    try {
      const failure = exportTable(client, "users", {
        columns,
        zip: true,
        output: join(folder, "users.zip"),
      });
      await expect(failure).rejects.toMatchObject({
        code: kind === "sql-error" ? "SQLITE_ERROR" : "REMOTE_ERROR",
      });
      expect(await readdir(folder)).toEqual([]);
      expect(client.closed).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);

it("does not reflect authentication error response bodies in exceptions", async () => {
  server.mode.status = 401;
  const stream = await exportTable(client, "users", { columns });
  await expect(new Response(stream).text()).rejects.toMatchObject({
    code: "REMOTE_ERROR",
    message: "Turso cursor request failed (HTTP 401).",
  });
  await expect(stream.result).rejects.toMatchObject({ code: "REMOTE_ERROR" });
});

it("rejects invalid bindings and undeclared projections before network I/O", async () => {
  // @ts-expect-error Remote exports need declarations, avoiding schema queries.
  await expect(exportTable(client, "users", {})).rejects.toMatchObject({
    code: "INVALID_OPTIONS",
  });
  await expect(
    exportQuery(client, {
      sql: "SELECT ? n",
      params: [NaN],
      columns: { n: integer() },
    }),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  await expect(
    exportQuery(client, {
      sql: "SELECT ? n",
      params: [1n << 63n],
      columns: { n: integer() },
    }),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  expect(server.requests).toEqual([]);
});

it.each([
  "DELETE FROM users RETURNING id",
  "PRAGMA user_version=99",
  "WITH x AS (SELECT 1) DELETE FROM users RETURNING id",
])("rejects non-read queries: %s", async (query) => {
  try {
    const stream = await exportQuery(client, {
      sql: query,
      columns: { id: integer() },
      format: "json",
    });
    await expect(new Response(stream).text()).rejects.toMatchObject({
      code: "SQLITE_ERROR",
    });
    await expect(stream.result).rejects.toMatchObject({ code: "SQLITE_ERROR" });
  } catch (cause) {
    expect(cause).toMatchObject({ code: "INVALID_QUERY" });
  }
  expect(native.prepare("SELECT count(*) n FROM users").get()).toEqual({
    n: 513,
  });
  expect(native.pragma("user_version", { simple: true })).toBe(0);
});

it.each(["esm", "cjs"])(
  "uses built %s direct and Drizzle entries",
  async (kind) => {
    const require = createRequire(import.meta.url);
    const built: typeof import("../src/turso.js") =
      kind === "esm"
        ? await import("../dist/turso.mjs")
        : require("../dist/turso.cjs");
    const core: typeof import("../src/index.js") =
      kind === "esm"
        ? await import("../dist/index.mjs")
        : require("../dist/index.cjs");
    const adapter: typeof import("../src/drizzle.js") =
      kind === "esm"
        ? await import("../dist/drizzle.mjs")
        : require("../dist/drizzle.cjs");
    const peer = built.createClient({ url: server.url });
    try {
      const direct = await built.exportTable(peer, "users", {
        columns: { id: core.integer().primaryKey() },
        format: "json",
      });
      expect((await new Response(direct).json()) as unknown[]).toHaveLength(
        513,
      );
      await direct.result;
      // The client and schema cross module formats; the registry remains shared.
      const remote = await adapter.exportTable(drizzle(client), table, {
        columns: { id: table.id },
        format: "json",
      });
      expect((await new Response(remote).json()) as unknown[]).toHaveLength(
        513,
      );
      await remote.result;
    } finally {
      await peer.close();
    }
  },
);

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for local protocol state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it.each([false, true])(
  "preserves destination callback errors (zip=%s)",
  async (zip) => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("disk full"));
      },
    });
    await expect(
      exportTable(client, "users", { columns, output, bufferSize: 1, zip }),
    ).rejects.toMatchObject({ code: "OUTPUT_ERROR" });
    expect(client.closed).toBe(false);
  },
);

it("cancels active exports on reconnect and then accepts a fresh export", async () => {
  server.mode.hold = "body";
  const stream = await exportTable(client, "users", { columns });
  const failure = expect(new Response(stream).text()).rejects.toMatchObject({
    code: "ABORTED",
  });
  await until(() => server.cursors === 1);
  await client.reconnect();
  await failure;
  await expect(stream.result).rejects.toMatchObject({ code: "ABORTED" });
  delete server.mode.hold;
  const next = await exportTable(client, "users", { columns });
  await new Response(next).arrayBuffer();
  expect((await next.result).rowsExported).toBe(513);
});

it("normalizes libsql URLs with tls=0 for the local HTTP endpoint", async () => {
  const peer = createClient({
    url: `${server.url.replace("http:", "libsql:")}?tls=0`,
  });
  try {
    const stream = await exportTable(peer, "users", { columns });
    await new Response(stream).arrayBuffer();
    await stream.result;
    expect(server.statements).toHaveLength(1);
  } finally {
    peer.close();
  }
});

it("runs the public API example against the local protocol server", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("../examples/turso.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        TURSO_DATABASE_URL: server.url,
        TURSO_AUTH_TOKEN: "local-fixture-token",
      },
    },
  );
  const results = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(results[0]).toHaveLength(513);
  expect(results[1]).toEqual([
    { id: 3, label: '雪 😀 "1"' },
    { id: 9, label: '雪 😀 "3"' },
  ]);
  expect(server.statements).toHaveLength(2);
  expect(server.sessions).toBe(0);
});

it.each(["UTF-16le", "UTF-16be"])(
  "exports a %s source through UTF-8 protocol text without probing encoding",
  async (encoding) => {
    await client.close();
    await server.close();
    native.close();
    native = new Database(":memory:");
    native.pragma(`encoding='${encoding}'`);
    native.exec(
      "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,active INTEGER); INSERT INTO users VALUES(1,'雪 😀',1)",
    );
    server = await tursoServer(native);
    client = createClient({ url: server.url });
    const stream = await exportTable(client, "users", {
      columns,
      format: "json",
    });
    expect(await new Response(stream).json()).toEqual([
      { id: 1, label: "雪 😀", enabled: true },
    ]);
    await stream.result;
    expect(server.statements).toHaveLength(1);
    expect(server.statements[0]).not.toMatch(/pragma|AS BLOB/i);
  },
);

it.each(["duplicate-step", "bad-count", "invalid-utf8", "row-after-end"])(
  "rejects malformed protocol data: %s",
  async (kind) => {
    const head = { baton: "fixture-baton", base_url: null };
    const begin = {
      type: "step_begin",
      step: 0,
      cols: [{ name: "json" }, { name: "count" }],
    };
    const row = {
      type: "row",
      row: [
        { type: "text", value: '[{"id":1}]' },
        { type: "integer", value: kind === "bad-count" ? "257" : "1" },
      ],
    };
    const end = { type: "step_end", step: 0 };
    const frames =
      kind === "duplicate-step"
        ? [head, begin, begin, row, end]
        : kind === "row-after-end"
          ? [head, begin, row, end, row]
          : [head, begin, row, end];
    const bytes =
      kind === "invalid-utf8"
        ? new Uint8Array([0xff])
        : Buffer.from(
            `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
          );
    const peer = createClient({
      url: server.url,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return request.url.endsWith("/v3/cursor")
          ? new Response(bytes)
          : Response.json({
              baton: null,
              results: [{ type: "ok", response: { type: "close" } }],
            });
      },
    });
    try {
      const stream = await exportTable(peer, "users", {
        columns,
        format: "json",
      });
      await expect(new Response(stream).text()).rejects.toMatchObject({
        code: "REMOTE_ERROR",
      });
      await expect(stream.result).rejects.toMatchObject({
        code: "REMOTE_ERROR",
      });
    } finally {
      await peer.close();
    }
  },
);

it("prepares current data and schema on the server without metadata checks", async () => {
  const first = await exportTable(client, "users", { columns });
  await new Response(first).arrayBuffer();
  await first.result;
  native.exec(
    "ALTER TABLE users ADD COLUMN extra TEXT; UPDATE users SET name='fresh' WHERE id=3",
  );
  const second = await drizzleTable(drizzle(client), table, {
    columns: { label: table.name },
    format: "json",
  });
  expect(((await new Response(second).json()) as unknown[])[0]).toEqual({
    label: "fresh",
  });
  await second.result;
  native.exec("ALTER TABLE users RENAME COLUMN name TO renamed");
  const broken = await exportTable(client, "users", { columns });
  await expect(new Response(broken).text()).rejects.toMatchObject({
    code: "SQLITE_ERROR",
  });
  await expect(broken.result).rejects.toMatchObject({ code: "SQLITE_ERROR" });
  expect(server.statements).toHaveLength(3);
});
