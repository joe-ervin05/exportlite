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
  console.log(stats); // rowsExported, bytesWritten, durationMs

  await exportQuery(db, {
    sql: "SELECT id, name FROM users WHERE active = ? ORDER BY id DESC",
    params: [1], // named parameters such as { active: 1 } also work
    output: "active-users.jsonl", // JSONL is the default
  });
} finally {
  db.close(); // the caller owns the connection
}
```

The local checkout builds to `dist/index.mjs` (ESM) and `dist/index.cjs` (CommonJS), with declarations for both formats. It uses `zip-stream` for ZIP output; the caller supplies `better-sqlite3` as a peer dependency. Nothing has been published to npm.

## Small API

| Option | Meaning |
| --- | --- |
| `output` | Required: a new file path or a byte-mode Node writable |
| `format` | `"jsonl"` (default) or `"json"` |
| `zip` | `true` streams a ZIP containing one exported file; default `false` |
| `columns` | Optional exact column names for `exportTable()` |
| `sql`, `params` | A trusted single SELECT/CTE and positional/named bindings for `exportQuery()` |
| `signal` | Optional `AbortSignal` |
| `end` | End a caller-provided writable when done; default `false` |
| `bufferSize` | Output flush target in UTF-8 bytes, 1 to 16 MiB; default 64 KiB |

Batch size is internal. Earlier `batchSize`, `targetBatchBytes` and `batchEstimator` options are absent from the types and rejected at runtime.

## ZIP downloads

```ts
await exportTable(db, "users", {
  format: "json",
  zip: true,
  output: "users.zip",
});
// The ZIP contains users.json.
```

ZIP bytes flow directly to the destination as the query runs. For an HTTP download, pass the response as `output`, set `end: true`, and set `Content-Type: application/zip` and `Content-Disposition: attachment; filename="users.zip"` in the application. Do not set `Content-Encoding: gzip` for a ZIP download. No complete export or archive is collected in memory.

The entry name is the table name with a `.json` or `.jsonl` extension; query exports use `export.json` or `export.jsonl`. Table names are sanitized to a single filename, limited to 80 characters before the extension, with path characters and Windows device names handled. ZIP metadata uses a fixed neutral timestamp. The download filename is still chosen by the output path or HTTP headers.

Internally, ZIP uses one continuous DEFLATE stream, compression level **1**, a **256 KiB zlib output buffer**, and ZIP64 support. These settings prioritize export speed and keep the API small. `bufferSize` still controls the uncompressed UTF-8 flush target; it does not configure compression or cap memory. The archive adds bounded stream buffers and checksum work. Empty exports still produce a valid archive containing `[]` or an empty JSONL file.

`bytesWritten` counts the complete ZIP file, including its headers, checksum descriptors and directory. Completion waits for the directory and last destination write, plus stream finalization when `end: true` is requested. Backpressure, cancellation, output ownership and partial-file cleanup follow the same rules as plain exports. A cancelled or failed archive is incomplete; caller streams can already contain ZIP bytes. Files created by the package are removed on handled failure.

Run `node examples/zip.mjs` for a working ZIP export. The [actual ZIP benchmarks](benchmarks/ZIP.md) compare the public option with JS object streaming using the same ZIP writer and settings.

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

Local checks cover 122 tests, ESM/CommonJS consumers, 256-row boundaries, all fallback kinds, parameter binding, Unicode/NULL/integer preservation, backpressure, cancellation, finalization, partial-file cleanup and concurrent WAL snapshot consistency. ZIP tests additionally decode archives with an independent reader, check CRC-32 and encoded byte statistics, and exercise footer-write errors. A separate `node benchmarks/validate-zip64.mjs` check streamed and fully decoded an actual entry larger than 4 GiB. A cross-version CI matrix has not yet been run. Run `node examples/batched.mjs` for a larger table export using the same API.

## Benchmarks

Build first, then compare the public table/query APIs with JS object streaming and full SQLite aggregation:

```sh
pnpm bench --rows=1000000 --width=32 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-narrow.json
pnpm bench --rows=100000 --width=1024 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-wide.json
node benchmarks/report.mjs
```

[Measured results and limitations](benchmarks/REPORT.md).

The earlier [streaming gzip comparison](benchmarks/COMPRESSION.md) measures ExportLite and JS object streaming with no compression, gzip level 1 and default gzip, including total file-completion time, encoded size and peak memory. Gzip lives entirely in that benchmark harness and uses Node's built-in `createGzip()`. Reproduction commands and raw runs are linked in that report.

The [varied-data comparison](benchmarks/VARIED-COMPRESSION.md) repeats those runs with seeded synthetic business records: distinct references, international names, variable-length support notes, NULLs and occasional longer notes. It includes measured note-size distributions, distinct-value counts and sample records. The earlier repetitive fixtures remain available as a separate comparison.

The [compression-buffer investigation](benchmarks/GZIP-INVESTIGATION.md) tests why large-record compression can hide ExportLite's speed advantage. Using `createGzip({ level: 1, chunkSize: 256 * 1024 })` improved the tested streaming pipeline without changing the export engine or compression ratio. This is the compressor's output-buffer size, separate from `bufferSize` and the stream's queue threshold. The report includes paired comparisons, rejected alternatives and limitations.

Benchmark tools and results are not shipped in the npm payload. CSV, relationship nesting, extra drivers and additional sizing controls are outside v0.

MIT licensed.
