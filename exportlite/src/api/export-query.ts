import type { InferColumns, SelectedColumns } from "../columns.js";
import { bindings, type SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { planQuery } from "../planner/json.js";
import type {
  ExportFormat,
  ExportResult,
  ExportStream,
  OutputRow,
  QueryExportOptions,
  QueryStreamOptions,
} from "../types.js";
import { deliverLocalExport } from "./export.js";

export function exportQuery(
  db: SQLiteConnection,
  options: QueryExportOptions,
): Promise<ExportResult>;
export function exportQuery<
  const C extends SelectedColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: SQLiteConnection,
  options: QueryStreamOptions & { columns: C; format?: F },
): Promise<ExportStream<OutputRow<InferColumns<C>, F>>>;
export function exportQuery(
  db: SQLiteConnection,
  options: QueryStreamOptions,
): Promise<ExportStream>;
export function exportQuery<
  const C extends SelectedColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: SQLiteConnection,
  options: (QueryExportOptions | QueryStreamOptions) & {
    columns: C;
    format?: F;
  },
): Promise<ExportResult | ExportStream<OutputRow<InferColumns<C>, F>>>;
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
  const { statement, header } = planQuery(
    db,
    options.sql,
    options.columns,
    options.format,
  );
  const args = bindings(options.params);
  return deliverLocalExport(
    statement,
    args,
    options,
    started,
    false,
    "export",
    header,
  );
}
