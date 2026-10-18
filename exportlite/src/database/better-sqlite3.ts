import { ExportLiteError, sqliteError } from "../errors.js";
import type { ReadStatement, SQLiteConnection } from "./adapter.js";

export function readStatement(
  db: SQLiteConnection,
  sql: string,
): ReadStatement {
  let statement: ReadStatement;
  try {
    statement = db.prepare(sql);
  } catch (cause) {
    throw new ExportLiteError(
      "INVALID_QUERY",
      "Expected one valid SQLite SELECT/CTE statement.",
      { cause },
    );
  }
  if (!statement.reader || !statement.readonly) {
    throw new ExportLiteError(
      "INVALID_QUERY",
      "Exports require a read-only statement that returns rows.",
    );
  }
  return statement;
}

export function checkCapabilities(db: SQLiteConnection): void {
  try {
    const version = db.prepare("SELECT sqlite_version()").pluck().get();
    const parts = String(version).split(".").map(Number);
    const [major = 0, minor = 0, patch = 0] = parts;
    if (
      major < 3 ||
      (major === 3 && (minor < 45 || (minor === 45 && patch < 1)))
    ) {
      throw new Error(`SQLite ${String(version)} is older than 3.45.1`);
    }
    const probe = db.prepare("SELECT json_object('ok', 1)").pluck().get();
    if (probe !== '{"ok":1}')
      throw new Error("SQLite JSON functions are unavailable");
  } catch (cause) {
    if (cause instanceof ExportLiteError) throw cause;
    throw new ExportLiteError(
      "UNSUPPORTED_SQLITE",
      "ExportLite requires SQLite >=3.45.1 with native JSON functions.",
      { cause },
    );
  }
}

export function* jsonRows(
  statement: ReadStatement,
  args: unknown[],
): Generator<string> {
  try {
    for (const value of statement.pluck().iterate(...args)) {
      if (typeof value !== "string")
        throw new Error("Expected SQLite JSON text");
      yield value;
    }
  } catch (error) {
    throw sqliteError(error);
  }
}

export function* jsonBatches(
  statement: ReadStatement,
  args: unknown[],
): Generator<[string, number | bigint]> {
  try {
    for (const value of statement.raw().iterate(...args)) {
      if (
        !Array.isArray(value) ||
        typeof value[0] !== "string" ||
        (typeof value[1] !== "number" && typeof value[1] !== "bigint") ||
        !Number.isSafeInteger(Number(value[1])) ||
        Number(value[1]) < 1
      ) {
        throw new Error("Expected a SQLite JSON batch and positive row count");
      }
      yield value as [string, number | bigint];
    }
  } catch (error) {
    throw sqliteError(error);
  }
}
