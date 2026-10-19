import type { SelectedColumns } from "../columns.js";
import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import type { DatabaseEncoding } from "../types.js";
import { prepareBatchedTable } from "./batches.js";
import { selectedFields, selectedObject } from "./columns.js";
import { identifier } from "./identifiers.js";

/** The request supplies the projection and key; no database metadata is read. */
export function planDeclaredTable(
  db: SQLiteConnection,
  table: string,
  columns: SelectedColumns,
  format: "json" | "jsonl",
  encoding: DatabaseEncoding,
) {
  const name = identifier(table);
  const fields = selectedFields(columns);
  const keys = fields.filter((field) => field.primary);
  if (
    keys.length === 1 &&
    keys[0]?.dataType === "integer" &&
    keys[0].kind === "value"
  ) {
    const batch = prepareBatchedTable(db, {
      table,
      key: `"__exportlite_source".${identifier(keys[0].column)}`,
      columns: fields.map((field) => field.column),
      fields,
      format,
      binary: encoding === "utf8",
      declared: true,
    });
    return { ...batch, batched: true };
  }
  const object = selectedObject(
    fields,
    (field) => `"__exportlite_source".${identifier(field.column)}`,
  );
  const sql = `SELECT ${object} FROM main.${name} AS "__exportlite_source"`;
  return { sql, statement: readStatement(db, sql), batched: false };
}
