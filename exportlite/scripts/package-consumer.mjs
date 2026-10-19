import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { parse } from "csv-parse/sync";
import { fromBufferPromise } from "yauzl";

const [mode, url] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const native = mode.includes("native");
const remote = mode.includes("turso");
const adapter = mode.startsWith("drizzle");
for (const [name, installed] of [
  ["better-sqlite3", native],
  ["@libsql/client", remote],
  ["drizzle-orm", adapter],
]) {
  if (installed) require.resolve(name);
  else assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
}
const expected = [
  { id: 1, name: "Jóe 雪" },
  { id: 2, name: null },
];
async function unzip(bytes, format = "json") {
  const archive = await fromBufferPromise(bytes);
  try {
    assert.equal(archive.entryCount, 1);
    for await (const entry of archive.eachEntry()) {
      assert.equal(entry.fileName, `export.${format}`);
      const chunks = [];
      for await (const chunk of await archive.openReadStreamPromise(entry))
        chunks.push(chunk);
      const json = Buffer.concat(chunks);
      assert.equal(crc32(json), entry.crc32);
      return format === "csv"
        ? parse(json, { columns: true })
        : JSON.parse(json.toString("utf8"));
    }
  } finally {
    archive.close();
  }
}
for (const format of ["import", "require"]) {
  const load =
    format === "import" ? (name) => import(name) : (name) => require(name);
  const core = await load("exportlite");
  assert.equal(typeof core.exportTable, "function");
  assert.equal(typeof core.exportQuery, "function");
  if (mode === "bare") continue;
  let api = core;
  let client;
  if (native) {
    const module = await load("better-sqlite3");
    const Database = module.default ?? module;
    client = new Database(":memory:");
    client.exec(
      "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'Jóe 雪'),(2,NULL)",
    );
  } else {
    api = await load("exportlite/turso");
    client = api.createClient({ url });
  }
  let db = client;
  let table = "users";
  if (adapter) {
    api = await load("exportlite/drizzle");
    const { drizzle } = await load(
      `drizzle-orm/${native ? "better-sqlite3" : "libsql/http"}`,
    );
    const { sqliteTable, integer, text } = await load(
      "drizzle-orm/sqlite-core",
    );
    db = drizzle(client);
    table = sqliteTable("users", { id: integer().primaryKey(), name: text() });
  }
  const columns = { id: core.integer().primaryKey(), name: core.text() };
  const query = (options) =>
    adapter
      ? api.exportQuery(db, db.select().from(table).orderBy(table.id), options)
      : api.exportQuery(client, {
          sql: "SELECT id,name FROM users ORDER BY id",
          ...(remote ? { columns } : {}),
          ...options,
        });
  try {
    const stream = await (adapter
      ? api.exportTable(db, table, { format: "json" })
      : api.exportTable(client, table, { columns, format: "json" }));
    assert.deepEqual(await new Response(stream).json(), expected);
    assert.equal((await stream.result).rowsExported, 2);
    const chunks = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    const stats = await query({ output, end: true, format: "json", zip: true });
    const zip = Buffer.concat(chunks);
    assert.deepEqual(await unzip(zip), expected);
    assert.equal(stats.bytesWritten, zip.length);
    assert(output.writableFinished);
    const csvExpected = [
      { id: "1", name: "Jóe 雪" },
      { id: "2", name: "" },
    ];
    for (const zip of [false, true]) {
      const csv = await query({ format: "csv", zip });
      const bytes = Buffer.from(await new Response(csv).arrayBuffer());
      assert.deepEqual(
        zip ? await unzip(bytes, "csv") : parse(bytes, { columns: true }),
        csvExpected,
      );
      assert.equal((await csv.result).rowsExported, 2);
    }
    const path = new URL(`./${format}.json`, import.meta.url);
    await query({ output: fileURLToPath(path), format: "json" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
    await rm(path);
    const cancelled = await query({ format: "json" });
    await cancelled.cancel();
    await assert.rejects(cancelled.result, { code: "ABORTED" });
  } finally {
    await client.close();
  }
}
console.log(`Verified ${mode}: ESM and CommonJS`);
