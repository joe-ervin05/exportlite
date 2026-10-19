import { ExportLiteError } from "../errors.js";
import type { QueryParameters } from "../types.js";

declare const tursoConnection: unique symbol;
/** Registered by exportlite/turso.createClient(); no native driver is required. */
export interface TursoConnection {
  readonly [tursoConnection]: true;
}

export interface TursoConfig {
  url: string;
  authToken?: string;
  remoteEncryptionKey?: string;
  tls?: boolean;
  fetch?: typeof globalThis.fetch;
}

interface Value {
  type: "null" | "integer" | "float" | "text" | "blob";
  value?: string | number;
  base64?: string;
}
export interface TursoStatement {
  sql: string;
  args: Value[];
  named_args: { name: string; value: Value }[];
  want_rows: true;
}
export type JsonFragment = readonly [json: string, rows: number];

// Share only a weak registry across the package's ESM and CommonJS entries.
const scope = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<object, TursoTransport> | undefined;
};
const registry = Symbol.for("exportlite.turso.v0");
const connections = scope[registry] ?? new WeakMap<object, TursoTransport>();
scope[registry] = connections;

export function registerTurso(
  client: object,
  config: TursoConfig,
  closed: () => boolean,
): TursoTransport {
  const transport = new TursoTransport(config, closed);
  connections.set(client, transport);
  return transport;
}

export function getTurso(client: unknown): TursoTransport | undefined {
  return client !== null && typeof client === "object"
    ? connections.get(client)
    : undefined;
}

export function tursoStatement(
  sql: string,
  params: QueryParameters | readonly unknown[] | undefined,
): TursoStatement {
  return {
    sql,
    args: Array.isArray(params) ? params.map(encodeValue) : [],
    named_args:
      params !== undefined && !Array.isArray(params)
        ? Object.entries(params).map(([name, value]) => ({
            name,
            value: encodeValue(value),
          }))
        : [],
    want_rows: true,
  };
}

function encodeValue(value: unknown): Value {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean")
    return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "bigint") {
    if (value >= -(1n << 63n) && value <= (1n << 63n) - 1n)
      return { type: "integer", value: String(value) };
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  } else if (value instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  } else if (value instanceof ArrayBuffer) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  throw new ExportLiteError(
    "INVALID_OPTIONS",
    "Invalid Turso parameter: use null, text, finite numbers, signed 64-bit integers or binary values.",
  );
}

/** One serialized export session per client, separate from SDK transactions. */
export class TursoTransport {
  private readonly base: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly headers: Headers;
  private session: { baton: string; base: string } | undefined;
  private lifecycle = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private readonly jobs = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;
  private shutdownFailure: unknown;

  constructor(
    config: TursoConfig,
    private readonly closed: () => boolean,
  ) {
    try {
      let url = new URL(config.url);
      const tls = config.tls ?? url.searchParams.get("tls") !== "0";
      if (url.protocol === "libsql:")
        url = new URL(`${tls ? "https:" : "http:"}${url.href.slice(7)}`);
      if ([...url.searchParams.keys()].some((key) => key !== "tls"))
        throw new Error("query");
      url.search = "";
      this.base = baseUrl(url);
      this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
      this.headers = new Headers({ "Content-Type": "application/json" });
      if (config.authToken)
        this.headers.set("Authorization", `Bearer ${config.authToken}`);
      if (config.remoteEncryptionKey)
        this.headers.set("x-turso-encryption-key", config.remoteEncryptionKey);
    } catch {
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "Turso requires a valid libsql:, https: or http: database URL and valid request headers.",
      );
    }
  }

  async run<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.checkOpen();
    const combined = AbortSignal.any([
      this.lifecycle.signal,
      ...(signal ? [signal] : []),
    ]);
    const job = deferred<void>();
    this.jobs.add(job.promise);
    let release: (() => void) | undefined;
    try {
      release = await this.acquire(combined);
      this.checkOpen();
      return await work(combined);
    } catch (cause) {
      if (release)
        await this.discard().catch((error: unknown) => {
          if (this.stopping) this.shutdownFailure ??= error;
        });
      if (combined.aborted) throw aborted(combined.reason);
      throw cause;
    } finally {
      release?.();
      this.jobs.delete(job.promise);
      job.resolve();
    }
  }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.lifecycle.abort(
      new ExportLiteError("ABORTED", "Turso client closed or reconnected."),
    );
    this.stopping = (async () => {
      await Promise.all([...this.jobs]);
      await this.discard();
      if (this.shutdownFailure !== undefined) throw this.shutdownFailure;
    })();
    void this.stopping.catch(() => {});
    return this.stopping;
  }

  reopen(): void {
    this.lifecycle = new AbortController();
    this.stopping = undefined;
    this.shutdownFailure = undefined;
  }

  private checkOpen(): void {
    if (this.closed() || this.stopping)
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "The Turso client is closed or reconnecting.",
      );
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    const previous = this.tail;
    const lease = deferred<void>();
    this.tail = previous.then(() => lease.promise);
    const cancelled = deferred<never>();
    const onAbort = () => cancelled.reject(aborted(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      await Promise.race([previous, cancelled.promise]);
      signal.throwIfAborted();
      return lease.resolve;
    } catch (cause) {
      lease.resolve();
      throw cause;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async discard(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await this.closeCursor(session.base, session.baton);
  }

  async *iterate(
    statement: TursoStatement,
    batched: boolean,
    format: "json" | "jsonl",
    signal: AbortSignal,
  ): AsyncGenerator<JsonFragment> {
    this.checkOpen();
    const request = new AbortController();
    const combined = AbortSignal.any([signal, request.signal]);
    let base = this.session?.base ?? this.base;
    let response: Response | undefined;
    let entries: AsyncGenerator<Record<string, unknown>> | undefined;
    let failure: unknown;
    try {
      combined.throwIfAborted();
      for (let attempt = 0; attempt < 2; attempt++) {
        const reused = this.session !== undefined;
        response = await this.fetch(`${base}/v3/cursor`, {
          method: "POST",
          headers: this.headers,
          redirect: "error",
          signal: combined,
          body: JSON.stringify({
            baton: this.session?.baton ?? null,
            batch: { steps: [{ stmt: statement }] },
          }),
        });
        // A rejected old baton has not started a new cursor. Never replay a
        // network failure, SQL error, or any response that began streaming.
        if (attempt === 0 && reused && (await expired(response))) {
          this.session = undefined;
          base = this.base;
          continue;
        }
        break;
      }
      if (!response) remote("Turso returned no cursor response.");
      if (!response.ok)
        remote(`Turso cursor request failed (HTTP ${response.status}).`);
      if (!response.body) remote("Turso returned no cursor body.");
      entries = cursorLines(response.body);
      const first = await entries.next();
      if (first.done) remote("Turso returned no cursor header.");
      const header = first.value;
      if (header.baton !== null && typeof header.baton !== "string")
        remote("Invalid Turso cursor header.");
      this.session =
        header.baton === null ? undefined : { baton: header.baton, base };
      if (header.base_url !== undefined && header.base_url !== null) {
        if (typeof header.base_url !== "string")
          remote("Invalid Turso cursor base URL.");
        const redirected = new URL(header.base_url, base);
        if (this.base.startsWith("https:") && redirected.protocol !== "https:")
          remote("Turso cursor attempted to downgrade HTTPS.");
        base = baseUrl(redirected);
        if (this.session) this.session.base = base;
      }
      let began = false;
      let ended = false;
      let terminated = false;
      for await (const entry of entries) {
        if (terminated) remote("Turso sent data after cursor termination.");
        if (entry.type === "error" || entry.type === "step_error") {
          const detail = record(entry.error);
          throw new ExportLiteError(
            "SQLITE_ERROR",
            `Turso SQL execution failed (${typeof detail.code === "string" ? detail.code : "SQLITE_ERROR"}).`,
          );
        }
        if (entry.type === "step_begin") {
          if (
            began ||
            ended ||
            entry.step !== 0 ||
            !Array.isArray(entry.cols) ||
            entry.cols.length !== (batched ? 2 : 1)
          )
            remote("Invalid Turso result columns or statement count.");
          began = true;
        } else if (entry.type === "row") {
          if (
            !began ||
            ended ||
            !Array.isArray(entry.row) ||
            entry.row.length !== (batched ? 2 : 1)
          )
            remote("Invalid Turso cursor row.");
          const payload = record(entry.row[0]);
          if (payload.type !== "text" || typeof payload.value !== "string")
            remote("Expected JSON text from Turso.");
          let count = 1;
          if (batched) {
            const value = record(entry.row[1]);
            if (
              value.type !== "integer" ||
              typeof value.value !== "string" ||
              !/^\d+$/.test(value.value)
            )
              remote("Invalid Turso batch count.");
            count = Number(value.value);
            if (!Number.isSafeInteger(count) || count < 1 || count > 256)
              remote("Invalid Turso batch count.");
            if (
              format === "json" &&
              (!payload.value.startsWith("[") || !payload.value.endsWith("]"))
            )
              remote("Invalid Turso JSON batch framing.");
          }
          yield [payload.value, count];
        } else if (entry.type === "step_end") {
          if (!began || ended || (entry.step !== undefined && entry.step !== 0))
            remote("Invalid Turso cursor completion.");
          ended = true;
        } else if (entry.type === "replication_index") {
          if (!ended)
            remote("Turso cursor terminated before statement completion.");
          terminated = true;
        } else remote("Unexpected Turso cursor entry.");
      }
      if (!ended) remote("Turso cursor ended before statement completion.");
    } catch (cause) {
      if (combined.aborted) failure = aborted(combined.reason);
      else if (isExportError(cause)) failure = cause;
      else
        failure = new ExportLiteError(
          "REMOTE_ERROR",
          "Turso cursor request or protocol failed.",
        );
    } finally {
      request.abort();
      await entries?.return(undefined).catch(() => {});
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
    }
    if (failure !== undefined) throw failure;
  }

  private async closeCursor(base: string, baton: string): Promise<void> {
    try {
      const response = await this.fetch(`${base}/v3/pipeline`, {
        method: "POST",
        headers: this.headers,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ baton, requests: [{ type: "close" }] }),
      });
      if (await expired(response)) return;
      if (!response.ok) {
        await response.body?.cancel();
        remote("Could not close the Turso export session.");
      }
      const body = record(await response.json());
      if (!Array.isArray(body.results) || body.results.length !== 1)
        remote("Invalid Turso session close response.");
      const result = record(body.results[0]);
      if (result.type !== "ok" || record(result.response).type !== "close")
        remote("Could not close the Turso export session.");
    } catch {
      remote("Could not close the Turso export session.");
    }
  }
}

function baseUrl(url: URL): string {
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    remote("Invalid Turso HTTP base URL.");
  return url.href.replace(/\/+$/, "");
}

async function* cursorLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let start = 0;
      let end = text.indexOf("\n", start);
      while (end !== -1) {
        parts.push(text.slice(start, end));
        const line = parts.join("").trim();
        parts.length = 0;
        if (line) yield record(JSON.parse(line));
        start = end + 1;
        end = text.indexOf("\n", start);
      }
      if (start < text.length) parts.push(text.slice(start));
      if (done) break;
    }
    const last = parts.join("").trim();
    if (last) yield record(JSON.parse(last));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    remote("Invalid Turso protocol object.");
  return value as Record<string, unknown>;
}

function remote(message: string): never {
  throw new ExportLiteError("REMOTE_ERROR", message);
}

function isExportError(value: unknown): value is ExportLiteError {
  return (
    value instanceof Error &&
    value.name === "ExportLiteError" &&
    typeof Reflect.get(value, "code") === "string"
  );
}

function aborted(reason: unknown): ExportLiteError {
  return isExportError(reason)
    ? reason
    : new ExportLiteError("ABORTED", "Export aborted.", { cause: reason });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Modern unknown/expired batons use 404; legacy libSQL names expiry in a 400. */
async function expired(response: Response): Promise<boolean> {
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return true;
  }
  if (response.status !== 400 || !response.body) return false;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) return false;
      parts.push(value);
    }
    const error: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return (
      error !== null &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "STREAM_EXPIRED"
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
