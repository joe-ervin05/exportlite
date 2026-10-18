# ExportLite — v0

Export SQLite tables and read-only queries to JSON or JSONL through an existing `better-sqlite3` connection. SQLite constructs the JSON; JavaScript writes the strings without parsing them or constructing row objects. This is a local, private prototype.

## Usage

```ts
import Database from "better-sqlite3";
import { exportTable, exportQuery } from "exportlite";

const db = new Database("app.sqlite", { readonly: true });
try {
  const stats = await exportTable(db, "users", {
    columns: ["id", "name", "email"], // optional
    format: "json",
    output: "users.json",
  });
  console.log(stats); // rowsExported, bytesWritten (UTF-8), durationMs

  await exportQuery(db, {
    sql: "SELECT id, name FROM users WHERE active = ? ORDER BY id DESC",
    params: [1], // named parameters such as { active: 1 } also work
    output: "active-users.jsonl", // JSONL is the default
  });
} finally {
  db.close(); // the caller owns the connection
}
```

The local checkout builds to `dist/index.mjs` (ESM) and `dist/index.cjs` (CommonJS), with declarations for both formats. It has no runtime package imports; the caller supplies `better-sqlite3` as a peer dependency. Nothing has been published to npm.

## Small API

| Option | Meaning |
| --- | --- |
| `output` | Required: a new file path or a byte-mode Node writable |
| `format` | `"jsonl"` (default) or `"json"` |
| `columns` | Optional exact column names for `exportTable()` |
| `sql`, `params` | A trusted single SELECT/CTE and positional/named bindings for `exportQuery()` |
| `signal` | Optional `AbortSignal` |
| `end` | End a caller-provided writable when done; default `false` |
| `bufferSize` | Output flush target in UTF-8 bytes, 1 to 16 MiB; default 64 KiB |

Batch size is internal. Earlier `batchSize`, `targetBatchBytes` and `batchEstimator` options are absent from the types and rejected at runtime.

## Fixed batching and streaming fallbacks

Ordinary main-schema rowid tables use **256-row batches**. One recursive export statement finds indexed rowid ranges and builds a JSON array or LF-separated JSON objects for each range. JavaScript joins those strings directly into the requested output. There are no SQL callbacks, sizing estimators, extra connections or pagination queries. Schema and capability checks still use their small metadata queries.

Views, virtual tables, WITHOUT ROWID tables, and tables shadowing all three rowid aliases automatically use the row-streaming path. Custom queries always stream individual SQLite-generated JSON records. Both paths share the same output loop, backpressure, cancellation and cleanup behavior. An execution failure never retries through a different path after writing partial data.

Batched tables are exported in ascending rowid order. Fallback table order follows SQLite; use a query with `ORDER BY` when ordering is essential. The active statement preserves one read snapshot while waiting for output. ExportLite does not manage caller transactions, and it never opens or closes the connection.

**256 rows is not a byte or RAM limit.** Large records, SQLite working memory, JS string copies and downstream buffers still consume memory. The library avoids retaining the complete export. Cancellation is checked between rows/batches and during output waits; an individual synchronous SQLite operation cannot be interrupted. The loop yields to the event loop after at least 2,048 rows.

## Streams and files

```ts
import { createWriteStream } from "node:fs";

const controller = new AbortController();
const output = createWriteStream("users.jsonl", { flags: "wx" });
output.on("error", console.error); // caller owns the stream

await exportTable(db, "users", {
  output,
  end: true,
  signal: controller.signal,
});
```

Paths are created exclusively: existing files are never overwritten, and parent directories must exist. ExportLite ends/closes its own files and removes a newly created partial file on failure or cancellation. There is no atomic replacement; another process can see a partial file, and abrupt termination can leave one behind.

Caller-provided streams remain open unless `end: true` is supplied. Exports honor both write callbacks and `drain`, await the last write, and optionally await finalization. Caller streams are not destroyed on failure and may contain partial JSON or an in-flight write. Keep a normal error handler attached and manage downstream pipeline completion in the application.

## Data and query behavior

- Main-schema tables/views are validated and identifiers quoted. Ordinary non-hidden columns are selected by default; generated columns can be selected explicitly.
- Query parameters are bound. Writes, PRAGMAs, multiple statements and duplicate output aliases are rejected before opening output. Query SQL is trusted application code, not a sandbox for functions with side effects.
- SQLite constructs strings, NULLs and numeric literals. JSON stored as TEXT stays a string. Exact signed 64-bit integer literals are preserved, including with a BigInt-configured connection; ordinary `JSON.parse()` consumers can still lose precision. REAL formatting remains SQLite's own.
- BLOBs fail with a descriptive error. Select other columns or use an explicit query with `hex()`/`CAST()`.
- Empty JSON is `[]`; empty JSONL is zero bytes. Export failures are `ExportLiteError` instances with a `code` and original cause where available.

SQLite >=3.45.1 with JSON support is checked before exporting. Do not close or mutate the same connection while an export is running. Queries may sort/materialize data within SQLite; long read snapshots can affect writers and WAL growth.

## Development and validation

Use Node.js 22.18+, 24.11+, or 26+ for the development tools and pnpm 12.14.0. Tested on Node 24.19.0. Dependency versions were checked on October 17, 2026; `better-sqlite3` remains 13.0.3. Direct development dependencies are pinned in the lockfile. tsdown warns that its TypeScript 7 compiler-API integration is experimental; declarations and typed consumers are checked locally.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check
pnpm example
```

Local checks cover 79 tests, ESM/CommonJS consumers, 256-row boundaries, all fallback kinds, parameter binding, Unicode/NULL/integer preservation, backpressure, cancellation, finalization, partial-file cleanup and concurrent WAL snapshot consistency. A cross-version CI matrix has not yet been run. Run `node examples/batched.mjs` for a larger table export using the same API.

## Benchmarks

Build first, then compare the public table/query APIs with JS object streaming and full SQLite aggregation:

```sh
pnpm bench --rows=1000000 --width=32 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-narrow.json
pnpm bench --rows=100000 --width=1024 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-wide.json
node benchmarks/report.mjs
```

[Measured results and limitations](benchmarks/REPORT.md). Benchmark tools and results are not shipped in the npm payload. CSV, relationship nesting, extra drivers and additional sizing controls are outside v0.

MIT licensed.
