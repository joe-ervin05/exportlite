import type { Writable } from "node:stream";
import type Database from "better-sqlite3";
import {
  type ExportResult,
  type ExportStream,
  exportQuery,
  exportTable,
  type SQLiteConnection,
} from "exportlite";

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
