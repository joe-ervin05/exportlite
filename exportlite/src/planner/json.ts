import type { SelectedColumns } from "../columns.js";
import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import { ExportLiteError, sqliteError } from "../errors.js";
import type { ExportFormat, TableColumns } from "../types.js";
import { planBatchedTable } from "./batches.js";
import {
  type SelectedField,
  selectedFields,
  selectedObject,
} from "./columns.js";
import { csvHeader, csvSource } from "./csv.js";
import { selectedTableSql } from "./declared.js";
import {
  identifier,
  literal,
  subquerySource,
  uniqueColumns,
} from "./identifiers.js";

export function planTable(
  db: SQLiteConnection,
  table: string,
  requested?: TableColumns,
  format: ExportFormat = "jsonl",
) {
  identifier(table);
  try {
    const fields =
      requested !== undefined && !Array.isArray(requested)
        ? selectedFields(requested as SelectedColumns)
        : undefined;
    const found = db
      .prepare(
        "SELECT name FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')",
      )
      .get(table) as { name: string } | undefined;
    if (!found)
      throw new ExportLiteError(
        "INVALID_SCHEMA",
        `Unknown table or view ${JSON.stringify(table)} in the main schema.`,
      );
    const metadata = db
      .prepare("SELECT name, hidden FROM pragma_table_xinfo(?, 'main')")
      .all(found.name) as { name: string; hidden: number | bigint }[];
    const available = new Set(
      metadata.filter((c) => Number(c.hidden) !== 1).map((c) => c.name),
    );
    const columns = fields
      ? fields.map((field) => field.column)
      : requested === undefined
        ? metadata.filter((c) => Number(c.hidden) === 0).map((c) => c.name)
        : [...(requested as readonly string[])];
    if (!fields) uniqueColumns(columns);
    for (const column of columns) {
      if (!available.has(column))
        throw new ExportLiteError(
          "INVALID_SCHEMA",
          `Unknown or hidden column ${JSON.stringify(column)} in ${JSON.stringify(found.name)}.`,
        );
    }
    const batched = planBatchedTable(db, {
      table: found.name,
      columnNames: metadata.map((column) => column.name),
      columns,
      ...(fields ? { fields } : {}),
      format,
    });
    if (batched) return { ...batched, batched: true };
    if (format === "csv") {
      const csvFields =
        fields ??
        columns.map((column) => ({
          key: column,
          column,
          kind: "value" as const,
          dataType: "text" as const,
          primary: false,
        }));
      const plan = selectedTableSql(found.name, csvFields, format, false);
      return { ...plan, statement: readStatement(db, plan.sql) };
    }
    const pairs = columns
      .map((c) => `${literal(c)}, ${identifier(c)}`)
      .join(", ");
    const sql = fields
      ? `SELECT ${selectedObject(fields, (field) => `"__exportlite_source".${identifier(field.column)}`)} FROM main.${identifier(found.name)} AS "__exportlite_source"`
      : `SELECT json_object(${pairs}) FROM main.${identifier(found.name)}`;
    return {
      statement: readStatement(db, sql),
      sql,
      batched: false,
      header: undefined,
    };
  } catch (error) {
    throw sqliteError(error);
  }
}

export function planQuery(
  db: SQLiteConnection,
  sql: string,
  declared?: SelectedColumns,
  format: ExportFormat = "jsonl",
) {
  validateQuery(sql);
  if (declared !== undefined) {
    const fields = selectedFields(declared);
    return planSelectedQuery(db, sql, fields, false, format);
  }
  const columns = readStatement(db, sql)
    .columns()
    .map((column) => column.name);
  uniqueColumns(columns);
  const fields = columns.map((key) => ({
    key,
    column: key,
    kind: "value" as const,
    dataType: "text" as const,
    primary: false,
  }));
  return planSelectedQuery(db, sql, fields, true, format);
}

/** Drizzle supplies selection order; no result metadata or rows are fetched. */
export function planSelectedQuery(
  db: SQLiteConnection,
  sql: string,
  fields: SelectedField[],
  positional: boolean,
  format: ExportFormat = "jsonl",
) {
  return {
    statement: readStatement(
      db,
      selectedQuerySql(sql, fields, positional, format),
    ),
    header:
      format === "csv"
        ? csvHeader(fields.map((field) => field.key))
        : undefined,
  };
}

export function selectedQuerySql(
  sql: string,
  fields: SelectedField[],
  positional: boolean,
  format: ExportFormat = "jsonl",
): string {
  validateQuery(sql);
  let name = "__exportlite_source";
  while (sql.toLowerCase().includes(name)) name += "_";
  const source = identifier(name);
  const aliases = positional
    ? `(${fields.map((_, i) => identifier(`c${i}`)).join(", ")})`
    : "";
  const object = selectedObject(
    fields,
    (field, i) =>
      `${source}.${identifier(positional ? `c${i}` : field.column)}`,
    format,
  );
  const input = subquerySource(sql);
  return `WITH ${source}${aliases} AS (\n${format === "csv" ? csvSource(input) : input}\n) SELECT ${object} FROM ${source}`;
}

function validateQuery(sql: string) {
  if (typeof sql !== "string" || !sql.trim())
    throw new ExportLiteError(
      "INVALID_QUERY",
      "sql must be a nonempty SELECT/CTE string.",
    );
  // Some PRAGMAs take effect at prepare time. Reject non-queries before preparing.
  if (
    !/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH)\b/i.test(sql)
  ) {
    throw new ExportLiteError(
      "INVALID_QUERY",
      "Only SELECT and WITH queries are supported.",
    );
  }
}
