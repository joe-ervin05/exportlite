import type { SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { createReadableExport } from "../output/readable.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { cachedTablePlan } from "../planner/cache.js";
import type {
  ExportResult,
  ExportStream,
  TableExportOptions,
  TableStreamOptions,
} from "../types.js";
import { streamExport } from "./export.js";

export function exportTable(
  db: SQLiteConnection,
  table: string,
  options: TableExportOptions,
): Promise<ExportResult>;
export function exportTable(
  db: SQLiteConnection,
  table: string,
  options?: TableStreamOptions,
): Promise<ExportStream>;
export function exportTable(
  db: SQLiteConnection,
  table: string,
  options: TableExportOptions | TableStreamOptions,
): Promise<ExportResult | ExportStream>;
export async function exportTable(
  db: SQLiteConnection,
  table: string,
  options: TableExportOptions | TableStreamOptions = {},
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  checkCapabilities(db);
  const { statement, batched } = cachedTablePlan(
    db,
    table,
    options.columns,
    options.format ?? "jsonl",
  );
  if (options.output === undefined)
    return createReadableExport(
      options,
      (destination) =>
        streamExport(statement, [], destination, started, batched, table),
      started,
    );
  return streamExport(statement, [], options, started, batched, table);
}
