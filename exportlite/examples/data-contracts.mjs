import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { exportQuery as drizzleQuery, exportTable } from "../dist/drizzle.mjs";
import { exportQuery, integer as int, text as str } from "../dist/index.mjs";

const client = new Database(":memory:");
try {
  client.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY, created_at INTEGER, payload BLOB,
      active INTEGER, note TEXT, metadata TEXT
    );
    INSERT INTO records VALUES
      (1, NULL, NULL, NULL, NULL, NULL),
      (9223372036854775807, 1700000000123, x'00FF', 1, '雪', '{"tags":["new"]}');
  `);
  const expected = [
    { id: "1", createdAt: null, payloadHex: null, active: null },
    {
      id: "9223372036854775807",
      createdAt: "2023-11-14T22:13:20.123Z",
      payloadHex: "00FF",
      active: true,
    },
  ];

  // Convert inside SQL so the wire contract needs no JavaScript row decoder.
  const direct = await exportQuery(client, {
    sql: `SELECT CAST(id AS TEXT) AS id,
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch') AS createdAt,
      CASE WHEN payload IS NULL THEN NULL ELSE hex(payload) END AS payloadHex,
      active FROM records ORDER BY records.id`,
    columns: {
      id: str().notNull(),
      createdAt: str(),
      payloadHex: str(),
      active: int({ mode: "boolean" }),
    },
    format: "json",
  });
  assert.deepEqual(await new Response(direct).json(), expected);
  assert.equal((await direct.result).rowsExported, 2);

  const records = sqliteTable("records", {
    id: integer().primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    payload: blob({ mode: "buffer" }),
    active: integer({ mode: "boolean" }),
    note: text(),
    metadata: text({ mode: "json" }),
  });
  const db = drizzle(client);
  const query = db
    .select({
      id: sql`CAST(${records.id} AS TEXT)`.as("id"),
      createdAt:
        sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${records.createdAt} / 1000.0, 'unixepoch')`.as(
          "createdAt",
        ),
      payloadHex:
        sql`CASE WHEN ${records.payload} IS NULL THEN NULL ELSE hex(${records.payload}) END`.as(
          "payloadHex",
        ),
      active: records.active,
    })
    .from(records)
    .orderBy(records.id);
  const selected = await drizzleQuery(db, query, { format: "json" });
  assert.deepEqual(await new Response(selected).json(), expected);
  await selected.result;

  // Supported columns can be selected even when other schema fields need decoders.
  const table = await exportTable(db, records, {
    columns: { note: records.note, metadata: records.metadata },
    format: "json",
  });
  assert.deepEqual(await new Response(table).json(), [
    { note: null, metadata: null },
    { note: "雪", metadata: { tags: ["new"] } },
  ]);
  await table.result;
  console.log("Data contracts verified.");
} finally {
  client.close();
}
