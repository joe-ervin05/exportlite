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
      "SELECT type, wr, (SELECT encoding FROM pragma_encoding) AS encoding FROM pragma_table_list WHERE schema = 'main' AND name = ?",
    )
    .get(options.table) as
    | { type: string; wr: number | bigint; encoding: string }
    | undefined;
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
  // CAST uses the database encoding. Keep UTF-16 databases on the text path;
  // UTF-8 databases can deliver JSON bytes without decoding and re-encoding.
  const payload =
    info.encoding === "UTF-8" ? `CAST(${aggregate} AS BLOB)` : aggregate;
  const first = '"__exportlite_batches"."first"';
  const last = '"__exportlite_batches"."last"';
  // Seek the first and 256th existing keys without per-key min/max/count work.
  // OFFSET is always 255 within the next range, never a growing page offset.
  // Keep integer bounds in SQLite; only a short final batch needs counting.
  const sql = `WITH RECURSIVE "__exportlite_batches"("first", "last") AS (
    SELECT
      (SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT 1),
      (SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT 1 OFFSET 255)
    UNION ALL
    SELECT
      (SELECT ${key} FROM ${table}
        WHERE ${key} > ${last} ORDER BY ${key} LIMIT 1),
      (SELECT ${key} FROM ${table}
        WHERE ${key} > ${last} ORDER BY ${key} LIMIT 1 OFFSET 255)
    FROM "__exportlite_batches"
    WHERE ${last} IS NOT NULL
  )
  SELECT (
    SELECT ${payload}
    FROM (SELECT ${columns} FROM ${table}
      WHERE ${key} BETWEEN ${first} AND coalesce(${last}, 9223372036854775807)
      ORDER BY ${key})
  ), CASE WHEN ${last} IS NOT NULL THEN 256 ELSE
    (SELECT count(*) FROM ${table} WHERE ${key} >= ${first}) END
  FROM "__exportlite_batches"
  WHERE ${first} IS NOT NULL`;
  return { statement: readStatement(db, sql), sql };
}
