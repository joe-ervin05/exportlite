import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/better-sqlite3";
import { blob, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { type ExportRow, exportQuery, text } from "exportlite";
import { exportQuery as drizzleQuery } from "exportlite/drizzle";
import { expectTypeOf } from "vitest";

declare const client: Database.Database;
declare const db: ReturnType<typeof drizzle>;
type WireRow = {
  id: string;
  createdAt: string | null;
  payloadHex: string | null;
};

const direct = exportQuery(client, {
  sql: `SELECT CAST(id AS TEXT) AS id,
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch') AS createdAt,
    CASE WHEN payload IS NULL THEN NULL ELSE hex(payload) END AS payloadHex
    FROM records`,
  columns: { id: text().notNull(), createdAt: text(), payloadHex: text() },
  format: "json",
});
expectTypeOf<ExportRow<typeof direct>>().toEqualTypeOf<WireRow>();

const records = sqliteTable("records", {
  id: integer().primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  payload: blob({ mode: "buffer" }),
});
const query = db
  .select({
    id: sql<string>`CAST(${records.id} AS TEXT)`.as("id"),
    createdAt: sql<
      string | null
    >`strftime('%Y-%m-%dT%H:%M:%fZ', ${records.createdAt} / 1000.0, 'unixepoch')`.as(
      "createdAt",
    ),
    payloadHex: sql<
      string | null
    >`CASE WHEN ${records.payload} IS NULL THEN NULL ELSE hex(${records.payload}) END`.as(
      "payloadHex",
    ),
  })
  .from(records);
const selected = drizzleQuery(db, query, { format: "json" });
expectTypeOf<ExportRow<typeof selected>>().toEqualTypeOf<WireRow>();

// The inferred contract describes wire strings; it does not revive Date objects.
const wire: WireRow = {
  id: "9223372036854775807",
  createdAt: null,
  payloadHex: null,
};
// @ts-expect-error ISO JSON dates remain strings after JSON.parse().
wire.createdAt = new Date();
// @ts-expect-error Exact string identifiers must not become JS numbers.
wire.id = Number(wire.id);
