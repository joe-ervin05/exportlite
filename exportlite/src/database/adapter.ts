import type { QueryParameters } from "../types.js";

export interface ResultColumn {
  name: string;
}

export interface ReadStatement {
  readonly reader: boolean;
  readonly readonly: boolean;
  columns(): ResultColumn[];
  pluck(toggle?: boolean): this;
  raw(toggle?: boolean): this;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/** Structural driver boundary: ExportLite never opens or closes a connection. */
export interface SQLiteConnection {
  prepare(sql: string): ReadStatement;
}

export function bindings(params: QueryParameters | undefined): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...params] : [params];
}
