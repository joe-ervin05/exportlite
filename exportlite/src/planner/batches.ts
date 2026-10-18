import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import { identifier, literal } from "./identifiers.js";

export function planBatchedTable(
  db: SQLiteConnection,
  options: {
    table: string;
    columnNames: readonly string[];
    columns: readonly string[];
    format: "json" | "jsonl";
  },
) {
  const info = db
    .prepare(
      "SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ?",
    )
    .get(options.table) as { type: string; wr: number | bigint } | undefined;
  if (info?.type !== "table" || Number(info.wr) !== 0) return undefined;
  const names = new Set(options.columnNames.map((name) => name.toLowerCase()));
  const rowid = ["rowid", "_rowid_", "oid"].find((name) => !names.has(name));
  if (!rowid) return undefined;
  const key = identifier(rowid);
  const table = `main.${identifier(options.table)} AS "__exportlite_source"`;
  const columns = options.columns.map(identifier).join(", ");
  const object = `json_object(${options.columns.map((column) => `${literal(column)}, ${identifier(column)}`).join(", ")})`;
  const aggregate =
    options.format === "json"
      ? `json_group_array(${object})`
      : `group_concat(${object}, char(10))`;
  // LIMIT applies to each key range. Only the small recursive frontier and one
  // aggregate are retained. No OFFSET, window numbering, or whole-input GROUP BY.
  const sql = `WITH RECURSIVE "__exportlite_batches"("bounds") AS (
    SELECT json_array(min("key"), max("key"), count(*))
    FROM (SELECT ${key} AS "key" FROM ${table} ORDER BY ${key} LIMIT 256)
    UNION ALL
    SELECT (
      SELECT json_array(min("key"), max("key"), count(*))
      FROM (SELECT ${key} AS "key" FROM ${table}
        WHERE ${key} > json_extract("__exportlite_batches"."bounds", '$[1]')
        ORDER BY ${key} LIMIT 256)
    )
    FROM "__exportlite_batches"
    WHERE json_extract("bounds", '$[2]') > 0
  )
  SELECT (
    SELECT ${aggregate}
    FROM (SELECT ${columns} FROM ${table}
      WHERE ${key} BETWEEN json_extract("__exportlite_batches"."bounds", '$[0]')
        AND json_extract("__exportlite_batches"."bounds", '$[1]')
      ORDER BY ${key})
  ), json_extract("bounds", '$[2]')
  FROM "__exportlite_batches"
  WHERE json_extract("bounds", '$[2]') > 0`;
  return readStatement(db, sql);
}
