import type { InferColumns, SelectedColumns } from "../columns.js";
import type { SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { ExportLiteError } from "../errors.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { cachedDeclaredTablePlan, cachedTablePlan } from "../planner/cache.js";
import type {
  ExportFormat,
  ExportResult,
  ExportStream,
  OutputRow,
  TableExportOptions,
  TableStreamOptions,
} from "../types.js";
import { deliverLocalExport } from "./export.js";

export function exportTable(
  db: SQLiteConnection,
  table: string,
  options: TableExportOptions,
): Promise<ExportResult>;
export function exportTable<
  const C extends SelectedColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: SQLiteConnection,
  table: string,
  options: TableStreamOptions & { columns: C; format?: F },
): Promise<ExportStream<OutputRow<InferColumns<C>, F>>>;
export function exportTable(
  db: SQLiteConnection,
  table: string,
  options?: TableStreamOptions,
): Promise<ExportStream>;
export function exportTable<
  const C extends SelectedColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: SQLiteConnection,
  table: string,
  options: (TableExportOptions | TableStreamOptions) & {
    columns: C;
    format?: F;
  },
): Promise<ExportResult | ExportStream<OutputRow<InferColumns<C>, F>>>;
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
  if (
    options.encoding !== undefined &&
    !["utf8", "utf16le", "utf16be"].includes(options.encoding)
  )
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "encoding must be utf8, utf16le or utf16be (the SQLite database encoding).",
    );
  const declared =
    options.columns !== undefined && !Array.isArray(options.columns);
  if (!declared) checkCapabilities(db);
  const { statement, batched, header } = declared
    ? cachedDeclaredTablePlan(
        db,
        table,
        options.columns as SelectedColumns,
        options.format ?? "jsonl",
        options.encoding ?? "utf8",
      )
    : cachedTablePlan(db, table, options.columns, options.format ?? "jsonl");
  return deliverLocalExport(
    statement,
    [],
    options,
    started,
    batched,
    table,
    header,
  );
}
