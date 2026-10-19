import type { SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import { ExportLiteError, sqliteError } from "../errors.js";
import { planBatchedTable } from "./batches.js";
import {
  identifier,
  literal,
  subquerySource,
  uniqueColumns,
} from "./identifiers.js";

export function planTable(
  db: SQLiteConnection,
  table: string,
  requested?: readonly string[],
  format: "json" | "jsonl" = "jsonl",
) {
  identifier(table);
  try {
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
    const columns =
      requested === undefined
        ? metadata.filter((c) => Number(c.hidden) === 0).map((c) => c.name)
        : [...requested];
    uniqueColumns(columns);
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
      format,
    });
    if (batched) return { statement: batched, batched: true };
    const pairs = columns
      .map((c) => `${literal(c)}, ${identifier(c)}`)
      .join(", ");
    return {
      statement: readStatement(
        db,
        `SELECT json_object(${pairs}) FROM main.${identifier(found.name)}`,
      ),
      batched: false,
    };
  } catch (error) {
    throw sqliteError(error);
  }
}

export function planQuery(db: SQLiteConnection, sql: string) {
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
  const source = readStatement(db, sql);
  const columns = source.columns().map((c) => c.name);
  uniqueColumns(columns);
  // Positional CTE aliases preserve even case-distinct or punctuation-heavy labels.
  const aliases = columns.map((_, i) => identifier(`c${i}`));
  const pairs = columns
    .map((c, i) => `${literal(c)}, ${aliases[i]}`)
    .join(", ");
  let name = "__exportlite_source";
  while (sql.toLowerCase().includes(name)) name += "_";
  const sourceName = identifier(name);
  return readStatement(
    db,
    `WITH ${sourceName}(${aliases.join(", ")}) AS (\n${subquerySource(sql)}\n) SELECT json_object(${pairs}) FROM ${sourceName}`,
  );
}
