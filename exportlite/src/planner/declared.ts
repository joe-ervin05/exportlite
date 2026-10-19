import type { SelectedColumns } from "../columns.js";
import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import type { DatabaseEncoding, ExportFormat } from "../types.js";
import { batchedTableSql } from "./batches.js";
import {
  type SelectedField,
  selectedFields,
  selectedObject,
} from "./columns.js";
import { csvHeader, csvSource } from "./csv.js";
import { identifier } from "./identifiers.js";

/** The request supplies the projection and key; no database metadata is read. */
export function planDeclaredTable(
  db: SQLiteConnection,
  table: string,
  columns: SelectedColumns,
  format: ExportFormat,
  encoding: DatabaseEncoding,
) {
  const plan = declaredTableSql(table, columns, format, encoding === "utf8");
  return { ...plan, statement: readStatement(db, plan.sql) };
}

export function declaredTableSql(
  table: string,
  columns: SelectedColumns,
  format: ExportFormat,
  binary: boolean,
) {
  const fields = selectedFields(columns);
  const keys = fields.filter((field) => field.primary);
  const key =
    keys.length === 1 &&
    keys[0]?.dataType === "integer" &&
    keys[0].kind === "value"
      ? keys[0].column
      : undefined;
  return selectedTableSql(table, fields, format, binary, key);
}

/** Shared schema-driven path; the key need not be included in the projection. */
export function planSelectedTable(
  db: SQLiteConnection,
  table: string,
  fields: SelectedField[],
  format: ExportFormat,
  encoding: DatabaseEncoding,
  key?: string,
) {
  const plan = selectedTableSql(
    table,
    fields,
    format,
    encoding === "utf8",
    key,
  );
  return { ...plan, statement: readStatement(db, plan.sql) };
}

export function selectedTableSql(
  table: string,
  fields: SelectedField[],
  format: ExportFormat,
  binary: boolean,
  key?: string,
) {
  const name = identifier(table);
  const header =
    format === "csv" ? csvHeader(fields.map((field) => field.key)) : undefined;
  if (key !== undefined) {
    const sql = batchedTableSql({
      table,
      key: `"__exportlite_source".${identifier(key)}`,
      columns: fields.map((field) => field.column),
      fields,
      format,
      binary,
      declared: true,
    });
    return { sql, batched: true, header };
  }
  const object = selectedObject(
    fields,
    (field, i) =>
      `"__exportlite_source".${identifier(format === "csv" ? `__exportlite_c${i}` : field.column)}`,
    format,
  );
  let source = `main.${name}`;
  if (format === "csv") {
    const projection = fields
      .map(
        (field, i) =>
          `"__exportlite_source".${identifier(field.column)} AS ${identifier(`__exportlite_c${i}`)}`,
      )
      .join(", ");
    source = `(${csvSource(`SELECT ${projection} FROM main.${name} AS "__exportlite_source"`)})`;
  }
  const sql = `SELECT ${object} FROM ${source} AS "__exportlite_source"`;

  return { sql, batched: false, header };
}
