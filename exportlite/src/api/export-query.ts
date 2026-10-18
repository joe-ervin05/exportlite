import { bindings, type SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { planQuery } from "../planner/json.js";
import type { ExportResult, QueryExportOptions } from "../types.js";
import { streamExport } from "./export.js";

export async function exportQuery(
  db: SQLiteConnection,
  options: QueryExportOptions,
): Promise<ExportResult> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  checkCapabilities(db);
  const statement = planQuery(db, options.sql);
  return streamExport(statement, bindings(options.params), options, started);
}
