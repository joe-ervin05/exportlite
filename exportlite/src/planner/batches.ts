import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import type { ExportFormat } from "../types.js";
import { type SelectedField, selectedObject } from "./columns.js";
import { csvHeader, csvRecord } from "./csv.js";
import { identifier, literal } from "./identifiers.js";

export function planBatchedTable(
  db: SQLiteConnection,
  options: {
    table: string;
    columnNames: readonly string[];
    columns: readonly string[];
    fields?: readonly SelectedField[];
    format: ExportFormat;
  },
) {
  const info = db
    .prepare(
      "SELECT type, wr, (SELECT encoding FROM pragma_encoding) AS encoding FROM pragma_table_list WHERE schema = 'main' AND name = ?",
    )
    .get(options.table) as
    | { type: string; wr: number | bigint; encoding: string }
    | undefined;
  if (info?.type !== "table" || Number(info.wr) !== 0) return undefined;
  const names = new Set(options.columnNames.map((name) => name.toLowerCase()));
  const rowid = ["rowid", "_rowid_", "oid"].find((name) => !names.has(name));
  if (!rowid) return undefined;
  return prepareBatchedTable(db, {
    ...options,
    key: identifier(rowid),
    binary: info.encoding === "UTF-8",
  });
}

/** Both planners share the same fixed-size, indexed-seek export statement. */
export function prepareBatchedTable(
  db: SQLiteConnection,
  options: BatchedTableOptions,
) {
  const sql = batchedTableSql(options);
  return {
    statement: readStatement(db, sql),
    sql,
    header:
      options.format === "csv"
        ? csvHeader(
            options.fields?.map((field) => field.key) ?? options.columns,
          )
        : undefined,
  };
}

interface BatchedTableOptions {
  table: string;
  key: string;
  columns: readonly string[];
  fields?: readonly SelectedField[];
  format: ExportFormat;
  binary: boolean;
  declared?: boolean;
}

/** SQL construction is shared by local prepared statements and remote cursors. */
export function batchedTableSql(options: BatchedTableOptions): string {
  const key = options.key;
  const table = `main.${identifier(options.table)} AS "__exportlite_source"`;
  const columns = options.fields
    ? options.fields
        .map(
          (field, i) =>
            `"__exportlite_source".${identifier(field.column)} AS ${identifier(`__exportlite_c${i}`)}`,
        )
        .join(", ")
    : options.columns.map(identifier).join(", ");
  const object = options.fields
    ? selectedObject(
        options.fields,
        (_field, i) => identifier(`__exportlite_c${i}`),
        options.format,
      )
    : options.format === "csv"
      ? csvRecord(options.columns.map(identifier))
      : `json_object(${options.columns.map((column) => `${literal(column)}, ${identifier(column)}`).join(", ")})`;
  const aggregate =
    options.format === "json"
      ? `json_group_array(${object})`
      : `group_concat(${object}, ${options.format === "csv" ? "char(13, 10)" : "char(10)"})`;
  // CAST uses the database encoding. CSV's temporary ASCII prefix makes a
  // wrong UTF-8 claim distinguishable from a valid record beginning with NUL.
  // The adapter removes the prefix without copying the native buffer.
  const binaryValue =
    options.format === "csv" ? `char(13, 10) || ${aggregate}` : aggregate;
  const payload = options.binary ? `CAST(${binaryValue} AS BLOB)` : aggregate;
  const first = '"__exportlite_batches"."first"';
  const last = '"__exportlite_batches"."last"';
  // A declared key must be non-null. Empty tables still return no boundary.
  const firstKey = options.declared
    ? `CASE WHEN ${key} IS NULL THEN json('ExportLite: primary key must not be null') ELSE ${key} END`
    : key;
  const upper = options.declared
    ? `(SELECT ${key} FROM ${table} ORDER BY ${key} DESC LIMIT 1)`
    : "9223372036854775807";
  // Seek the first and 256th existing keys without per-key min/max/count work.
  // OFFSET is always 255 within the next range, never a growing page offset.
  // Keep integer bounds in SQLite; only a short final batch needs counting.
  const sql = `WITH RECURSIVE "__exportlite_batches"("first", "last") AS (
    SELECT
      (SELECT ${firstKey} FROM ${table} ORDER BY ${key} LIMIT 1),
      (SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT 1 OFFSET 255)
    UNION ALL
    SELECT
      (SELECT ${firstKey} FROM ${table}
        WHERE ${key} > ${last} ORDER BY ${key} LIMIT 1),
      (SELECT ${key} FROM ${table}
        WHERE ${key} > ${last} ORDER BY ${key} LIMIT 1 OFFSET 255)
    FROM "__exportlite_batches"
    WHERE ${last} IS NOT NULL
  )
  SELECT (
    SELECT ${payload}
    FROM (SELECT ${columns} FROM ${table}
      WHERE ${key} BETWEEN ${first} AND coalesce(${last}, ${upper})
      ORDER BY ${key})
  ), CASE WHEN ${last} IS NOT NULL THEN 256 ELSE
    (SELECT count(*) FROM ${table} WHERE ${key} >= ${first}) END
  FROM "__exportlite_batches"
  WHERE ${first} IS NOT NULL`;
  return sql;
}
