import type { Writable } from "node:stream";

export type SqlValue = null | string | number | bigint | Buffer;
export type QueryParameters =
  | readonly SqlValue[]
  | Readonly<Record<string, SqlValue>>;

export interface ExportOptions {
  /** JSONL by default. */
  format?: "json" | "jsonl";
  /** Stream one JSON/JSONL file in a ZIP archive. Default: false. */
  zip?: boolean;
  /** Paths must not already exist. Caller streams remain open by default. */
  output: string | Writable;
  /** End a caller-provided stream after exporting. Default: false. */
  end?: boolean;
  signal?: AbortSignal;
  /** Output buffer flush target, 1 UTF-8 byte to 16 MiB. Default: 64 KiB. */
  bufferSize?: number;
}

export interface TableExportOptions extends ExportOptions {
  /** Exact column names; default: ordinary, non-hidden columns of a main-schema table/view. */
  columns?: readonly string[];
}

export interface QueryExportOptions extends ExportOptions {
  /** Trusted, single, read-only SELECT/CTE, with optional trailing semicolon/comments. */
  sql: string;
  params?: QueryParameters;
}

/** Omit output to receive a readable; its lifecycle is managed by consumption. */
export interface StreamExportOptions
  extends Omit<ExportOptions, "output" | "end"> {
  output?: undefined;
  end?: never;
}

export interface TableStreamOptions extends StreamExportOptions {
  columns?: readonly string[];
}

export interface QueryStreamOptions extends StreamExportOptions {
  sql: string;
  params?: QueryParameters;
}

export interface ExportStream extends ReadableStream<Uint8Array> {
  /** Resolves after consumption and export cleanup; rejects on failure/cancellation. */
  readonly result: Promise<ExportResult>;
}

export interface ExportResult {
  rowsExported: number;
  /** Actual destination bytes, including the complete archive when zip is true. */
  bytesWritten: number;
  durationMs: number;
}
