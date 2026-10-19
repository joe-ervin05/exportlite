import {
  type Client,
  type Config,
  createClient as createLibsqlClient,
} from "@libsql/client/http";
import { deliverTursoExport } from "./api/export-turso.js";
import type { InferColumns, SelectedColumns } from "./columns.js";
import { registerTurso, type TursoConnection } from "./database/turso.js";
import { ExportLiteError } from "./errors.js";
import { checkAborted, validateOptions } from "./output/writer.js";
import { selectedFields } from "./planner/columns.js";
import { declaredTableSql } from "./planner/declared.js";
import { selectedQuerySql } from "./planner/json.js";
import type {
  ExportResult,
  ExportStream,
  QueryExportOptions,
  QueryStreamOptions,
  TableExportOptions,
  TableStreamOptions,
} from "./types.js";

export type { TursoConnection } from "./database/turso.js";
export interface TursoClientConfig extends Omit<Config, "fetch"> {
  fetch?: typeof globalThis.fetch;
}
export type TursoClient = Omit<Client, "close"> &
  TursoConnection & { close(): Promise<void> };

/** An ordinary official HTTP client, also registered for streaming exports. */
export function createClient(config: TursoClientConfig): TursoClient {
  let client: Client;
  try {
    client = createLibsqlClient(config);
  } catch {
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "Invalid Turso HTTP client configuration.",
    );
  }
  const transport = registerTurso(client, config, () => client.closed);
  const close = client.close.bind(client);
  const reconnect = client.reconnect.bind(client);
  let closing: Promise<void> | undefined;
  let reconnecting: Promise<void> | undefined;
  let revision = 0;
  client.close = () => {
    if (closing) return closing;
    const current = ++revision;
    const pendingReconnect = reconnecting;
    close();
    closing = (async () => {
      try {
        await transport.close();
      } finally {
        await pendingReconnect?.catch(() => {});
        if (current === revision) close();
      }
    })();
    void closing.catch(() => {});
    return closing;
  };
  client.reconnect = () => {
    if (reconnecting) return reconnecting;
    const current = ++revision;
    closing = undefined;
    const stopped = transport.close();
    reconnecting = (async () => {
      await stopped;
      await reconnect();
      if (current !== revision) {
        close();
        return;
      }
      transport.reopen();
    })();
    const task = reconnecting;
    void task
      .finally(() => {
        if (reconnecting === task) reconnecting = undefined;
      })
      .catch(() => {});
    return task;
  };
  return client as TursoClient;
}

type TableDestination<C extends SelectedColumns = SelectedColumns> = Omit<
  TableExportOptions,
  "columns" | "encoding"
> & { columns: C };
type TableReadable<C extends SelectedColumns> = Omit<
  TableStreamOptions,
  "columns" | "encoding"
> & { columns: C };
type QueryDestination<C extends SelectedColumns = SelectedColumns> =
  QueryExportOptions & { columns: C };
type QueryReadable<C extends SelectedColumns> = QueryStreamOptions & {
  columns: C;
};

export function exportTable(
  client: TursoConnection,
  table: string,
  options: TableDestination,
): Promise<ExportResult>;
export function exportTable<const C extends SelectedColumns>(
  client: TursoConnection,
  table: string,
  options: TableReadable<C>,
): Promise<ExportStream<InferColumns<C>>>;
export function exportTable<const C extends SelectedColumns>(
  client: TursoConnection,
  table: string,
  options: TableDestination<C> | TableReadable<C>,
): Promise<ExportResult | ExportStream<InferColumns<C>>>;
export async function exportTable(
  client: TursoConnection,
  table: string,
  options: TableDestination | TableReadable<SelectedColumns>,
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  requireColumns(options.columns);
  const plan = declaredTableSql(
    table,
    options.columns,
    options.format ?? "jsonl",
    false,
  );
  return deliverTursoExport(
    client,
    plan.sql,
    undefined,
    options,
    started,
    plan.batched,
    table,
  );
}

export function exportQuery(
  client: TursoConnection,
  options: QueryDestination,
): Promise<ExportResult>;
export function exportQuery<const C extends SelectedColumns>(
  client: TursoConnection,
  options: QueryReadable<C>,
): Promise<ExportStream<InferColumns<C>>>;
export function exportQuery<const C extends SelectedColumns>(
  client: TursoConnection,
  options: QueryDestination<C> | QueryReadable<C>,
): Promise<ExportResult | ExportStream<InferColumns<C>>>;
export async function exportQuery(
  client: TursoConnection,
  options: QueryDestination | QueryReadable<SelectedColumns>,
): Promise<ExportResult | ExportStream> {
  const started = performance.now();
  validateOptions(options);
  checkAborted(options.signal);
  requireColumns(options.columns);
  const sql = selectedQuerySql(
    options.sql,
    selectedFields(options.columns),
    false,
  );
  return deliverTursoExport(client, sql, options.params, options, started);
}

function requireColumns(
  columns: SelectedColumns | undefined,
): asserts columns is SelectedColumns {
  if (columns === undefined || Array.isArray(columns))
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "Turso exports require declared columns to avoid metadata requests.",
    );
}
