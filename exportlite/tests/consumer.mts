import type { Writable } from "node:stream";
import type Database from "better-sqlite3";
import {
  type ExportResult,
  type ExportRow,
  type ExportStream,
  exportQuery,
  exportTable,
  type InferColumns,
  integer,
  real,
  type SQLiteConnection,
  text,
} from "exportlite";
import { expectTypeOf } from "vitest";

declare const db: Database.Database;
declare const output: Writable;
const connection: SQLiteConnection = db;
export const tableResult: Promise<ExportResult> = exportTable(
  connection,
  "users",
  { output },
);
export const batchedResult: Promise<ExportResult> = exportTable(db, "users", {
  output,
  format: "json",
  zip: true,
});
export const queryResult: Promise<ExportResult> = exportQuery(db, {
  sql: "SELECT ? AS n",
  params: [1n],
  format: "json",
  zip: true,
  output,
});
export const tableStream: Promise<ExportStream> = exportTable(db, "users");
export const queryStream: Promise<ExportStream> = exportQuery(db, {
  sql: "SELECT ? AS n",
  params: [1n],
  zip: true,
});
export async function webResponse(request: Request) {
  const stream = await exportTable(db, "users", {
    format: "json",
    zip: true,
    signal: request.signal,
  });
  const stats: Promise<ExportResult> = stream.result;
  void stats;
  // @ts-expect-error Web streams are returned directly; there is no toWeb helper.
  void stream.toWeb;
  return new Response(stream);
}
// @ts-expect-error Readables manage their own end; end requires a destination.
exportTable(db, "users", { end: true });
// @ts-expect-error A query still requires SQL when output is omitted.
exportQuery(db, { zip: true });
// @ts-expect-error CSV is deliberately outside the prototype API.
exportTable(db, "users", { format: "csv", output });
// @ts-expect-error Batch sizing is internal to v0.
exportTable(db, "users", { output, batchSize: 256 });
// @ts-expect-error Adaptive tuning is outside the v0 API.
exportTable(db, "users", { output, targetBatchBytes: 262_144 });
// @ts-expect-error Percentile tuning is outside the v0 API.
exportTable(db, "users", { output, batchEstimator: "p95" });

// @ts-expect-error ZIP is a boolean switch.
exportTable(db, "users", { output, zip: "true" });

const selection = {
  userId: integer("id").primaryKey(),
  displayName: text("name").notNull(),
  email: text(),
  active: integer({ mode: "boolean" }).notNull(),
  score: real(),
};
type User = {
  userId: number;
  displayName: string;
  email: string | null;
  active: boolean;
  score: number | null;
};
expectTypeOf<InferColumns<typeof selection>>().toEqualTypeOf<User>();
const typedTable = exportTable(db, "users", { columns: selection });
const typedQuery = exportQuery(db, {
  sql: "SELECT id, name, email, active, score FROM users",
  columns: selection,
});
expectTypeOf<ExportRow<typeof typedTable>>().toEqualTypeOf<User>();
expectTypeOf<ExportRow<typeof typedQuery>>().toEqualTypeOf<User>();
const inline = exportTable(db, "users", {
  columns: { id: integer().notNull(), renamed: text("name") },
});
exportTable(db, "users", { columns: selection, encoding: "utf16be" });
// @ts-expect-error Encoding describes SQLite's supported database encodings.
exportTable(db, "users", { columns: selection, encoding: "latin1" });
expectTypeOf<ExportRow<typeof inline>>().toEqualTypeOf<{
  id: number;
  renamed: string | null;
}>();
const typedDestination = exportQuery(db, {
  sql: "SELECT 1 AS n",
  columns: { n: integer() },
  output,
});
expectTypeOf(typedDestination).toEqualTypeOf<Promise<ExportResult>>();
// @ts-expect-error Selected types come from column builders.
exportTable(db, "users", { columns: { id: "number" } });
// @ts-expect-error Type declarations use builders rather than configuration records.
exportQuery(db, { sql: "SELECT 1 AS id", columns: { id: { type: "number" } } });
// @ts-expect-error Only number and boolean integer modes are supported.
integer({ mode: "timestamp" });
