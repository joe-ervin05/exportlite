import {
  type GetColumnData,
  getTableColumns,
  is,
  type Query,
  SQL,
} from "drizzle-orm";
import {
  BaseSQLiteDatabase,
  getTableConfig,
  SQLiteColumn,
  type SQLiteSyncDialect,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { deliverLocalExport } from "./api/export.js";
import { deliverTursoExport } from "./api/export-turso.js";
import type { SQLiteConnection } from "./database/adapter.js";
import { getTurso, type TursoConnection } from "./database/turso.js";
import { ExportLiteError } from "./errors.js";
import { checkAborted, validateOptions } from "./output/writer.js";
import { cachedSelectedTablePlan } from "./planner/cache.js";
import type { SelectedField } from "./planner/columns.js";
import { csvHeader } from "./planner/csv.js";
import { selectedTableSql } from "./planner/declared.js";
import { identifier, uniqueColumns } from "./planner/identifiers.js";
import { planSelectedQuery, selectedQuerySql } from "./planner/json.js";
import type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  ExportStream,
  OutputRow,
  StreamExportOptions,
  TableExportOptions,
  TableStreamOptions,
} from "./types.js";

/** A native or registered Turso $client. Caller retains ownership. */
export interface DrizzleSQLiteDatabase {
  readonly $client: SQLiteConnection | TursoConnection;
}

export type DrizzleColumns = Readonly<Record<string, SQLiteColumn>>;
export type InferDrizzleColumns<C extends DrizzleColumns> = {
  -readonly [K in keyof C]: GetColumnData<C[K]>;
};
type TableDestination<C extends DrizzleColumns = DrizzleColumns> = Omit<
  TableExportOptions,
  "columns"
> & { columns?: C };
type TableReadable<C extends DrizzleColumns> = Omit<
  TableStreamOptions,
  "columns"
> & { columns?: C };

/** Flat SQLite selects, including filters, joins, ordering, limits and CTEs. */
export interface DrizzleSelectQuery {
  toSQL(): Query;
  readonly _: { readonly dialect: "sqlite"; readonly result: unknown[] };
}

export function exportTable(
  db: DrizzleSQLiteDatabase,
  table: SQLiteTable,
  options: TableDestination,
): Promise<ExportResult>;
export function exportTable<
  T extends SQLiteTable,
  const C extends DrizzleColumns = T["_"]["columns"],
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  table: T,
  options?: TableReadable<C> & { format?: F },
): Promise<ExportStream<OutputRow<InferDrizzleColumns<C>, F>>>;
export function exportTable<
  T extends SQLiteTable,
  const C extends DrizzleColumns = T["_"]["columns"],
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  table: T,
  options: (TableReadable<C> | TableDestination<C>) & { format?: F },
): Promise<ExportResult | ExportStream<OutputRow<InferDrizzleColumns<C>, F>>>;
export async function exportTable(
  db: DrizzleSQLiteDatabase,
  table: SQLiteTable,
  options: TableDestination | TableReadable<DrizzleColumns> = {},
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  const { client, dialect, remote } = connection(db);
  if (!is(table, SQLiteTable)) invalid("Pass a Drizzle SQLite table.");
  if (
    options.encoding !== undefined &&
    !["utf8", "utf16le", "utf16be"].includes(options.encoding)
  )
    invalid("encoding must be utf8, utf16le or utf16be.");
  const available = Object.values(getTableColumns(table));
  const selected = options.columns ?? getTableColumns(table);
  const fields = entries(selected).map(([key, column]) => {
    if (!is(column, SQLiteColumn) || !available.includes(column))
      invalid("Table selections must contain columns from that table.");
    return field(key, column, dialect.casing.getColumnCasing(column));
  });
  // A table-level key can be composite. Never batch on just one member of it.
  const config = getTableConfig(table);
  const primary = [
    ...available.filter((column) => column.primary),
    ...config.primaryKeys.flatMap((key) => key.columns),
  ];
  const keys = [...new Set(primary)];
  const key =
    keys.length === 1 && keys[0]?.columnType === "SQLiteInteger"
      ? dialect.casing.getColumnCasing(keys[0])
      : undefined;
  if (remote) {
    const plan = selectedTableSql(
      config.name,
      fields,
      options.format ?? "jsonl",
      false,
      key,
    );
    return deliverTursoExport(
      client as TursoConnection,
      plan.sql,
      undefined,
      options,
      started,
      plan.batched,
      config.name,
      plan.header,
    );
  }
  const plan = cachedSelectedTablePlan(
    client as SQLiteConnection,
    config.name,
    fields,
    options.format ?? "jsonl",
    options.encoding ?? "utf8",
    key,
  );
  return deliverLocalExport(
    plan.statement,
    [],
    options,
    started,
    plan.batched,
    config.name,
    plan.header,
  );
}

export function exportQuery<Q extends DrizzleSelectQuery>(
  db: DrizzleSQLiteDatabase,
  query: Q,
  options: ExportOptions,
): Promise<ExportResult>;
export function exportQuery<
  Q extends DrizzleSelectQuery,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  query: Q,
  options?: StreamExportOptions & { format?: F },
): Promise<ExportStream<OutputRow<Q["_"]["result"][number], F>>>;
export function exportQuery<
  Q extends DrizzleSelectQuery,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  query: Q,
  options: (ExportOptions | StreamExportOptions) & { format?: F },
): Promise<ExportResult | ExportStream<OutputRow<Q["_"]["result"][number], F>>>;
export function exportQuery(
  db: DrizzleSQLiteDatabase,
  query: SQL,
  options: ExportOptions & { columns: DrizzleColumns },
): Promise<ExportResult>;
export function exportQuery<
  const C extends DrizzleColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  query: SQL,
  options: StreamExportOptions & { columns: C; format?: F },
): Promise<ExportStream<OutputRow<InferDrizzleColumns<C>, F>>>;
export function exportQuery<
  const C extends DrizzleColumns,
  const F extends ExportFormat | undefined = "json" | "jsonl" | undefined,
>(
  db: DrizzleSQLiteDatabase,
  query: SQL,
  options: (StreamExportOptions | ExportOptions) & { columns: C; format?: F },
): Promise<ExportResult | ExportStream<OutputRow<InferDrizzleColumns<C>, F>>>;
export async function exportQuery(
  db: DrizzleSQLiteDatabase,
  query: DrizzleSelectQuery | SQL,
  options: (ExportOptions | StreamExportOptions) & {
    columns?: DrizzleColumns;
  } = {},
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  const { client, dialect, remote } = connection(db);
  const raw = is(query, SQL);
  let compiled: Query;
  let selection: Record<string, unknown>;
  if (raw) {
    if (!options.columns) invalid("Raw Drizzle SQL requires columns metadata.");
    compiled = dialect.sqlToQuery(query);
    selection = options.columns;
  } else {
    const metadata = query as DrizzleSelectQuery & {
      getSelectedFields?: () => Record<string, unknown>;
    };
    if (
      typeof query?.toSQL !== "function" ||
      typeof metadata.getSelectedFields !== "function"
    )
      invalid("Pass a Drizzle SQLite select query or sql template.");
    if (options.columns !== undefined)
      invalid("Select queries already supply their columns metadata.");
    compiled = query.toSQL();
    try {
      selection = Object.fromEntries(
        Object.entries(metadata.getSelectedFields()),
      );
    } catch (cause) {
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "Give SQL expressions an .as(...) alias before exporting a Drizzle select.",
        { cause },
      );
    }
  }
  const fields = entries(selection).map(([key, value]) =>
    field(
      key,
      value,
      is(value, SQLiteColumn) ? dialect.casing.getColumnCasing(value) : key,
    ),
  );
  // Positional CTE names preserve repeated sources and Drizzle's JS aliases.
  if (remote)
    return deliverTursoExport(
      client as TursoConnection,
      selectedQuerySql(compiled.sql, fields, !raw, options.format),
      compiled.params,
      options,
      started,
      false,
      "export",
      options.format === "csv"
        ? csvHeader(fields.map((field) => field.key))
        : undefined,
    );
  const { statement, header } = planSelectedQuery(
    client as SQLiteConnection,
    compiled.sql,
    fields,
    !raw,
    options.format,
  );
  return deliverLocalExport(
    statement,
    compiled.params,
    options,
    started,
    false,
    "export",
    header,
  );
}

function field(key: string, value: unknown, name: string): SelectedField {
  let kind: SelectedField["kind"] = "value";
  let dataType: SelectedField["dataType"] = "text";
  if (is(value, SQLiteColumn)) {
    switch (value.columnType) {
      case "SQLiteInteger":
        dataType = "integer";
        break;
      case "SQLiteReal":
        dataType = "real";
        break;
      case "SQLiteText":
        break;
      case "SQLiteBoolean":
        dataType = "integer";
        kind = "boolean";
        break;
      case "SQLiteTextJson":
        kind = "json";
        break;
      default:
        invalid(
          `Drizzle column ${JSON.stringify(key)} uses ${value.columnType}, which requires a JavaScript decoder. Select a SQL text/number expression instead.`,
        );
    }
  } else if (is(value, SQL.Aliased) || is(value, SQL)) {
    const expression = is(value, SQL.Aliased) ? value.sql : value;
    // Use the expression's own SQL class so mixed ESM/CJS imports and multiple
    // Drizzle installations compare against the correct default decoder.
    const SQLClass = expression.constructor as typeof SQL;
    const decoder = (item: SQL) =>
      (item as unknown as { decoder: unknown }).decoder;
    if (decoder(expression) !== decoder(new SQLClass([])))
      invalid(
        "Drizzle .mapWith() decoders cannot run inside SQLite JSON generation.",
      );
  } else {
    invalid("Only flat Drizzle column/SQL selections are supported.");
  }
  identifier(name);
  return { key, column: name, kind, dataType, primary: false };
}

function entries(value: unknown): [string, unknown][] {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("columns must be a flat object of Drizzle columns.");
  const result = Object.entries(value);
  uniqueColumns(result.map(([key]) => key));
  return result;
}

function connection(db: DrizzleSQLiteDatabase) {
  const remote = getTurso(db?.$client);
  if (
    !is(db, BaseSQLiteDatabase) ||
    (!remote &&
      !(
        db.$client &&
        "prepare" in db.$client &&
        typeof db.$client.prepare === "function"
      ))
  )
    invalid(
      "The Drizzle adapter requires drizzle-orm/better-sqlite3 with a live $client, or a Turso client created by exportlite/turso.",
    );
  // Drizzle does not expose its configured casing/dialect in public typings.
  // Reuse it so automatic casing and sql template bindings match the caller.
  const dialect = (
    db as unknown as {
      dialect: Pick<SQLiteSyncDialect, "sqlToQuery"> & {
        casing: { getColumnCasing(column: SQLiteColumn): string };
      };
    }
  ).dialect;
  if (!dialect?.casing || typeof dialect.sqlToQuery !== "function")
    invalid(
      "Unsupported Drizzle dialect. This adapter supports Drizzle 0.45.x.",
    );
  return { client: db.$client, dialect, remote: remote !== undefined };
}

function invalid(message: string): never {
  throw new ExportLiteError("INVALID_OPTIONS", message);
}
