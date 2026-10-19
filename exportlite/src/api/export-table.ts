import type { SQLiteConnection } from "../database/adapter.js";
import { checkCapabilities } from "../database/better-sqlite3.js";
import { checkAborted, validateOptions } from "../output/writer.js";
import { planTable } from "../planner/json.js";
import type { ExportResult, TableExportOptions } from "../types.js";
import { streamExport } from "./export.js";

export async function exportTable(
  db: SQLiteConnection,
  table: string,
  options: TableExportOptions,
): Promise<ExportResult> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  checkCapabilities(db);
  const { statement, batched } = planTable(
    db,
    table,
    options.columns,
    options.format ?? "jsonl",
  );
  return streamExport(statement, [], options, started, batched, table);
}
