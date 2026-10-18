import type { Writable } from "node:stream";
import type Database from "better-sqlite3";
import {
  type ExportResult,
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
});
export const queryResult: Promise<ExportResult> = exportQuery(db, {
  sql: "SELECT ? AS n",
  params: [1n],
  format: "json",
  output,
});
// @ts-expect-error CSV is deliberately outside the prototype API.
exportTable(db, "users", { format: "csv", output });
// @ts-expect-error Batch sizing is internal to v0.
exportTable(db, "users", { output, batchSize: 256 });
// @ts-expect-error Adaptive tuning is outside the v0 API.
exportTable(db, "users", { output, targetBatchBytes: 262_144 });
// @ts-expect-error Percentile tuning is outside the v0 API.
exportTable(db, "users", { output, batchEstimator: "p95" });
