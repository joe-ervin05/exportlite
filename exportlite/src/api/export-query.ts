import type { InferColumns, SelectedColumns } from "../columns.js";
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
export function exportQuery<const C extends SelectedColumns>(
  db: SQLiteConnection,
  options: QueryStreamOptions & { columns: C },
): Promise<ExportStream<InferColumns<C>>>;
export function exportQuery(
  db: SQLiteConnection,
  options: QueryStreamOptions,
): Promise<ExportStream>;
export function exportQuery<const C extends SelectedColumns>(
  db: SQLiteConnection,
  options: (QueryExportOptions | QueryStreamOptions) & { columns: C },
): Promise<ExportResult | ExportStream<InferColumns<C>>>;
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
  // A declared query needs only its final statement: SQLite validates support
  // while preparing it, with no capability or schema preflight queries.
  if (options.columns === undefined) checkCapabilities(db);
  const statement = planQuery(db, options.sql, options.columns);
  const args = bindings(options.params);
  if (options.output === undefined)
    return createReadableExport(
      options,
      (destination) => streamExport(statement, args, destination, started),
      started,
    );
  return streamExport(statement, args, options, started);
}
