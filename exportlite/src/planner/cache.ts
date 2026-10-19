import type { SelectedColumns } from "../columns.js";
import type { ReadStatement, SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import { sqliteError } from "../errors.js";
import type { DatabaseEncoding, ExportFormat, TableColumns } from "../types.js";
import type { SelectedField } from "./columns.js";
import { planDeclaredTable, planSelectedTable } from "./declared.js";
import { identifier } from "./identifiers.js";
import { planTable } from "./json.js";

type CachedPlan = Pick<
  ReturnType<typeof planTable>,
  "sql" | "batched" | "header"
>;
interface Cache {
  schema?: ReadStatement;
  version?: string;
  plans: Map<string, CachedPlan>;
}

// Bound retained metadata/SQL. Every export gets an independent statement.
const caches = new WeakMap<SQLiteConnection, Cache>();

function cacheFor(db: SQLiteConnection): Cache {
  let cache = caches.get(db);
  if (!cache) {
    cache = { plans: new Map() };
    caches.set(db, cache);
  }
  return cache;
}

function cachedPlan(
  db: SQLiteConnection,
  cache: Cache,
  key: string,
  build: () => ReturnType<typeof planTable>,
): ReturnType<typeof planTable> {
  const cached = cache.plans.get(key);
  const plan = cached
    ? { ...cached, statement: readStatement(db, cached.sql) }
    : build();
  cache.plans.delete(key);
  cache.plans.set(key, {
    sql: plan.sql,
    batched: plan.batched,
    header: plan.header,
  });
  if (cache.plans.size > 16) {
    const oldest = cache.plans.keys().next().value;
    if (oldest !== undefined) cache.plans.delete(oldest);
  }
  return plan;
}

export function cachedDeclaredTablePlan(
  db: SQLiteConnection,
  table: string,
  columns: SelectedColumns,
  format: ExportFormat,
  encoding: DatabaseEncoding,
): ReturnType<typeof planTable> {
  identifier(table);
  try {
    return cachedPlan(
      db,
      cacheFor(db),
      JSON.stringify(["declared", table, columns, format, encoding]),
      () => planDeclaredTable(db, table, columns, format, encoding),
    );
  } catch (error) {
    throw sqliteError(error);
  }
}

export function cachedTablePlan(
  db: SQLiteConnection,
  table: string,
  columns: TableColumns | undefined,
  format: ExportFormat,
): ReturnType<typeof planTable> {
  identifier(table);
  try {
    const cache = cacheFor(db);
    cache.schema ??= db.prepare("PRAGMA main.schema_version").pluck();
    const version = String(cache.schema.get());
    if (version !== cache.version) {
      cache.plans.clear();
      cache.version = version;
    }
    const key = JSON.stringify([table, columns ?? null, format]);
    return cachedPlan(db, cache, key, () =>
      planTable(db, table, columns, format),
    );
  } catch (error) {
    throw sqliteError(error);
  }
}

export function cachedSelectedTablePlan(
  db: SQLiteConnection,
  table: string,
  fields: SelectedField[],
  format: ExportFormat,
  encoding: DatabaseEncoding,
  primaryKey?: string,
): ReturnType<typeof planTable> {
  identifier(table);
  try {
    return cachedPlan(
      db,
      cacheFor(db),
      JSON.stringify(["selected", table, fields, format, encoding, primaryKey]),
      () => planSelectedTable(db, table, fields, format, encoding, primaryKey),
    );
  } catch (error) {
    throw sqliteError(error);
  }
}
