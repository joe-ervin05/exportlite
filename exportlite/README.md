# ExportLite — v0

Export SQLite tables and read-only queries to JSON or JSONL through an existing `better-sqlite3` connection. Omit `output` to receive a Web readable stream, or pass a file path/Node writable destination. SQLite constructs the JSON; JavaScript writes the strings without parsing them or constructing row objects. This is a local, private prototype.

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
| `output` | Optional new file path or byte-mode Node writable; omit to receive a Web `ExportStream` |
| `format` | `"jsonl"` (default) or `"json"` |
| `zip` | `true` streams a ZIP containing one exported file; default `false` |
| `columns` | Optional exact column names for `exportTable()` |
| `sql`, `params` | A trusted single SELECT/CTE and positional/named bindings for `exportQuery()` |
| `signal` | Optional `AbortSignal` |
| `end` | With `output` only: end a caller-provided writable when done; default `false` |
| `bufferSize` | Output flush target in UTF-8 bytes, 1 to 16 MiB; default 64 KiB |

Batch size is internal. Earlier `batchSize`, `targetBatchBytes` and `batchEstimator` options are absent from the types and rejected at runtime.

TypeScript infers the return type from whether `output` is present. `TableStreamOptions` and `QueryStreamOptions` describe readable calls; the existing destination option types retain a required `output`.

## Readable streams and API responses

Omitting `output` returns a `Promise<ExportStream>`. The resolved value is a Web `ReadableStream<Uint8Array>` that works directly as a `Response` body, with `.result` for completion statistics. It supports plain JSON/JSONL and `zip: true` with the same options as destination exports. There is no `toWeb()` helper.

```js
// In an API handler with an open db connection:
export async function GET(request) {
  const stream = await exportTable(db, "users", {
    columns: ["id", "name", "email"],
    format: "json",
    zip: true,
    signal: request.signal,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="users.zip"',
    },
  });
}
```

Query exports can return a readable in the same way:

```js
const stream = await exportQuery(db, {
  sql: "SELECT id, name FROM users WHERE active = @active ORDER BY id",
  params: { active: 1 },
  format: "json",
});

return new Response(stream, {
  headers: { "Content-Type": "application/json" },
});
```

For Node HTTP responses or files, the existing `output` option still works:

```js
const stats = await exportTable(db, "users", {
  output: res, // JSONL by default
  end: true,
});

await exportTable(db, "users", { output: "users.jsonl" });
```

Options, schema and SQL are validated before the readable is returned. The export data statement starts when reading begins, and backpressure pauses further rows/batches. The read snapshot starts with consumption. Cancelling the stream or its reader, stopping async iteration, or aborting `signal` cancels production and releases the statement and owned ZIP stages. `await stream.cancel()` waits for that cleanup. For a Node pipeline, use Node's built-in `Readable.fromWeb(stream)` adapter; it forwards failures and cancellation between the two stream interfaces. The caller retains ownership of the SQLite connection.

Keep that connection open until `stream.result` settles. Read or pipe the stream before awaiting `.result`; the promise waits for consumption and export cleanup. Statistics count the exported bytes, including ZIP headers/trailer when enabled, and do not mean an HTTP client has received them. For readables, `durationMs` includes elapsed time waiting for consumption. If using a connection per request, close it from the completion callbacks rather than immediately after returning the `Response`.

Row-time SQLite and ZIP failures reach both the readable and `.result`. Cancel unused streams with `await stream.cancel()`; when a reader holds the stream's lock, use `await reader.cancel()` instead. The package observes its internal completion rejection so applications that only consume the body do not acquire an unhandled promise rejection. `end` applies only to a provided destination and is rejected when `output` is omitted. Run `node examples/readable.mjs` for a ZIP response consumed through a file pipeline.

Frameworks that accept Web `Response` objects can use these examples directly, provided the route runs in Node with access to the SQLite connection. For tRPC applications, use a normal authenticated download route for the export bytes; a typed tRPC procedure can return its URL and filename. tRPC's [`httpBatchStreamLink`](https://trpc.io/docs/client/links/httpBatchStreamLink) streams values through its own JSON protocol rather than serving the raw ZIP or JSON download. ExportLite returns bytes and does not infer TypeScript row types from SQLite schemas or SQL strings.

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

The [naive JavaScript comparison](benchmarks/NAIVE.md) adds `all()` followed by `JSON.stringify()` of the complete row array, with plain JSON and ZIP output. It measures total time, encoded size and peak memory alongside both streaming implementations on the same varied fixtures.

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

Local checks cover 168 tests, ESM/CommonJS consumers, 256-row boundaries, all fallback kinds, parameter binding, Unicode/NULL/integer preservation, backpressure, cancellation, finalization, partial-file cleanup and concurrent WAL snapshot consistency. Readable tests cover lazy execution, one data statement, Web `Response` bodies and writable streams, Node pipelines, cancellation/disconnects, errors and completion statistics. ZIP tests additionally decode archives with an independent reader, check CRC-32 and encoded byte statistics, and exercise footer-write errors. A separate `node benchmarks/validate-zip64.mjs` check streamed and fully decoded an actual entry larger than 4 GiB. A cross-version CI matrix has not yet been run. Run `node examples/batched.mjs` for a larger table export using the same API.

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
