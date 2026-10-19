import { bindings, type SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { createReadableExport } from "../output/readable.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { planQuery } from "../planner/json.js";
import type {
  ExportResult,
  ExportStream,
  QueryExportOptions,
  QueryStreamOptions,
} from "../types.js";
import { streamExport } from "./export.js";

export function exportQuery(
  db: SQLiteConnection,
  options: QueryExportOptions,
): Promise<ExportResult>;
export function exportQuery(
  db: SQLiteConnection,
  options: QueryStreamOptions,
): Promise<ExportStream>;
export function exportQuery(
  db: SQLiteConnection,
  options: QueryExportOptions | QueryStreamOptions,
): Promise<ExportResult | ExportStream>;
export async function exportQuery(
  db: SQLiteConnection,
  options: QueryExportOptions | QueryStreamOptions,
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  checkCapabilities(db);
  const statement = planQuery(db, options.sql);
  const args = bindings(options.params);
  if (options.output === undefined)
    return createReadableExport(
      options,
      (destination) => streamExport(statement, args, destination, started),
      started,
    );
  return streamExport(statement, args, options, started);
}
