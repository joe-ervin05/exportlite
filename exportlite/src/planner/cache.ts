import type { ReadStatement, SQLiteConnection } from "../database/adapter.js";
import { readStatement } from "../database/better-sqlite3.js";
import { sqliteError } from "../errors.js";
import { identifier } from "./identifiers.js";
import { planTable } from "./json.js";

type CachedPlan = Pick<ReturnType<typeof planTable>, "sql" | "batched">;
interface Cache {
  schema: ReadStatement;
  version?: string;
  plans: Map<string, CachedPlan>;
}

// Bound retained metadata/SQL. Every export gets an independent statement.
const caches = new WeakMap<SQLiteConnection, Cache>();

export function cachedTablePlan(
  db: SQLiteConnection,
  table: string,
  columns: readonly string[] | undefined,
  format: "json" | "jsonl",
): ReturnType<typeof planTable> {
  identifier(table);
  try {
    let cache = caches.get(db);
    if (!cache) {
      cache = {
        schema: db.prepare("PRAGMA main.schema_version").pluck(),
        plans: new Map(),
      };
      caches.set(db, cache);
    }
    const version = String(cache.schema.get());
    if (version !== cache.version) {
      cache.plans.clear();
      cache.version = version;
    }
    const key = JSON.stringify([table, columns ?? null, format]);
    const cached = cache.plans.get(key);
    const plan = cached
      ? { ...cached, statement: readStatement(db, cached.sql) }
      : planTable(db, table, columns, format);
    cache.plans.delete(key);
    cache.plans.set(key, { sql: plan.sql, batched: plan.batched });
    if (cache.plans.size > 16) {
      const oldest = cache.plans.keys().next().value;
      if (oldest !== undefined) cache.plans.delete(oldest);
    }
    return plan;
  } catch (error) {
    throw sqliteError(error);
  }
}
