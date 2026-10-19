# ExportLite — v0

Export SQLite tables and read-only queries to JSON or JSONL through `better-sqlite3` or Turso/libSQL HTTP, directly or using a Drizzle schema. Omit `output` to receive a Web readable stream, or pass a file path/Node writable destination. SQLite constructs the JSON; JavaScript writes JSON fragments without parsing the exported records or constructing row objects. This is a private prototype.

The [API and data contracts](docs/contracts.md) define supported drivers and field modes, validation and stream lifetime, SQL conversion recipes, transaction boundaries, and remote queue ownership. Turso support is experimental until live qualification. The existing API and JSONL default are retained.

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

The local checkout builds ESM and CommonJS entry points with declarations for both formats. It uses `zip-stream` for ZIP output. Install `better-sqlite3` for local connections, `@libsql/client` for Turso, and `drizzle-orm` when using the Drizzle adapter; these driver peers are optional so unused drivers need not be installed. Nothing has been published to npm.

## Small API

| Option | Meaning |
| --- | --- |
| `output` | Optional new file path or byte-mode Node writable; omit to receive a Web `ExportStream` |
| `format` | `"jsonl"` (default) or `"json"` |
| `zip` | `true` streams a ZIP containing one exported file; default `false` |
| `columns` | Optional column-name list for tables, or an object of typed column selections for tables and queries |
| `sql`, `params` | A trusted single SELECT/CTE and positional/named bindings for `exportQuery()` |
| `signal` | Optional `AbortSignal` |
| `end` | With `output` only: end a caller-provided writable when done; default `false` |

The existing `encoding` and `bufferSize` options remain available under [advanced options](docs/advanced.md). Encoding describes the SQLite database; buffer size is a flush target.

Batch size is internal. Earlier `batchSize`, `targetBatchBytes` and `batchEstimator` options are absent from the types and rejected at runtime.

TypeScript infers the return type from whether `output` is present. `TableStreamOptions` and `QueryStreamOptions` describe readable calls; the existing destination option types retain a required `output`.

## Declared columns and aliases

Use the small, Drizzle-style builders to declare a projection without repeating types at every call. Object keys become JSON keys; an optional builder argument supplies a different source column name. These are ExportLite builders for reading an existing database, with no Drizzle dependency or schema-creation behavior.

```ts
import { exportTable, integer, text, type ExportRow } from "exportlite";

const columns = {
  id: integer().primaryKey(),
  displayName: text("name").notNull(),
  email: text(),
};

const stream = await exportTable(db, "users", {
  columns,
  format: "json",
});

type User = ExportRow<typeof stream>;
// { id: number; displayName: string; email: string | null }

return new Response(stream, {
  headers: { "Content-Type": "application/json" },
});
```

`integer()`, `real()` and `text()` describe numbers and strings. Fields are nullable by default; `.notNull()` declares that the source cannot be null. `.primaryKey()` also makes the selected type non-null and declares an existing unique, non-null key. These declarations never create or change database constraints. `integer({ mode: "boolean" })` encodes SQLite 0/1 values as JSON false/true, preserving nulls and rejecting other representations. Text and numeric values pass through unchanged: these declarations are type contracts, without per-record JavaScript validation or coercion, and must match stored values.

Declared tables use one data SELECT with no schema, schema-version, capability or column-discovery preflight queries, including on the first call. One `integer().primaryKey()` field enables the existing 256-row indexed batching algorithm using that source column. The key must already be unique and non-null and should be indexed; uniqueness is a caller-supplied contract, not verified by a separate scan. This also works with an integer key on a WITHOUT ROWID table and tables shadowing SQLite's rowid aliases. Missing, text, boolean, real or multiple declared key fields use the row-streaming fallback without preflight queries. A null integer key fails instead of producing an empty export.

For declared local tables in UTF-16 databases, set the matching [database encoding](docs/advanced.md#sqlite-database-encoding). Output remains UTF-8, without an encoding preflight query.

`InferColumns<typeof columns>` also gives the selected row type directly. `ExportRow<typeof stream>` retains the selected type through the export call, including renamed fields. The readable still contains bytes; these types do not make `Response.json()` or a framework client infer the body type automatically. ZIP streams describe the rows inside the archive.

Declared queries select named fields from their SQL result, with normal parameter binding:

```ts
const stream = await exportQuery(db, {
  sql: "SELECT id, name, email FROM users WHERE active = ? ORDER BY id",
  params: [1],
  columns,
  format: "json",
});
```

With declared query columns, ExportLite prepares only the final JSON SELECT. There are no separate schema, schema-version, capability or output-column-discovery queries. SQLite validates the statement and its named result columns; a missing field fails during preparation. Query result aliases should be unique under SQLite's case-insensitive name resolution. Added, unselected columns do not change the projection. Renaming happens inside `json_object()`, with no JavaScript row objects or JSON parsing.

Local declared table plans cache only request-derived SQL and batching mode. Each export prepares a fresh statement against the actual schema, so unrelated schema changes need no invalidation and missing fields fail during preparation. Rows are read afresh. The original local table column-name list and automatic discovery retain their storage metadata queries and schema-version invalidation. Run `node examples/declared-columns.mjs` for a working example.

## Drizzle adapter

The optional `exportlite/drizzle` entry point accepts a Drizzle database and existing SQLite schemas. It supports **Drizzle ORM 0.45.x, tested with 0.45.4**, using `drizzle-orm/better-sqlite3` or a registered Turso client with `drizzle-orm/libsql/http` (also usable with `drizzle-orm/libsql`). Drizzle is an optional peer dependency; the main `exportlite` entry does not import it. Stable-version documentation uses `getTableColumns()`; the newer `getColumns()` name belongs to Drizzle v1.

```ts
import { eq, sql } from "drizzle-orm";
import { exportTable, exportQuery } from "exportlite/drizzle";
import type { ExportRow } from "exportlite";
import { db } from "./db";       // drizzle(client), better-sqlite3 driver
import { users } from "./schema"; // an existing sqliteTable declaration

const stream = await exportTable(db, users, {
  columns: { userId: users.id, displayName: users.name, email: users.email },
  format: "json",
});
type User = ExportRow<typeof stream>; // types and nullability from Drizzle
return new Response(stream, {
  headers: { "Content-Type": "application/json" },
});
```

Omitting `columns` exports the table's declared Drizzle columns with its JavaScript property names as JSON keys. An object selection renames or repeats fields without duplicating type declarations. The adapter respects Drizzle's configured column casing. A single integer primary key from either `.primaryKey()` or table-level `primaryKey({ columns: [...] })` enables the existing 256-row batches, even when that key is excluded from the JSON projection. Composite, text and missing keys use row streaming. Both paths prepare and execute one data statement with no schema or capability preflight queries. The Drizzle schema must match the database; fresh preparation catches missing fields, and extra database columns do not change the export.

Pass an unexecuted Drizzle select to reuse its filters, parameter encoders, aliases, flat joins, ordering, limits, grouping and CTEs:

```ts
const query = db.select({ id: users.id, label: users.name })
  .from(users).where(eq(users.active, true));
const stream = await exportQuery(db, query, { format: "json", zip: true });
```

The adapter compiles `.toSQL()` and reads selection metadata; it never awaits the query or calls Drizzle's `.all()`. Select queries retain their inferred row contract, including nullable columns from flat left joins. Give computed SQL expressions an `.as("alias")` alias. Ordinary select queries use the existing row-streaming query path; the integer-key table batching optimization applies to `exportTable()`. Drizzle's built-in query-result cache and row logging/mapping hooks are bypassed because ExportLite executes the generated JSON statement through a native cursor or the Turso streaming transport. No export result is cached.

Raw Drizzle `sql` templates also work. Supply the schema columns corresponding to the raw query's result column names; these fields supply output names and decoding metadata without a discovery query:

```ts
const stream = await exportQuery(
  db,
  sql`SELECT * FROM ${users} WHERE ${users.id} > ${100}`,
  { columns: { id: users.id, displayName: users.name }, format: "json" },
);
```

Supported schema values are plain `integer`, `real`, `text` (including enums), boolean integers and JSON-mode text. JSON-mode text becomes nested JSON rather than an escaped string. Boolean fields use ExportLite's strict 0/1 representation. A generic `sql<T>` annotation or `$type<T>()` is a caller-supplied type contract, not runtime validation; computed SQL selections should return JSON scalar values. To embed stored JSON objects/arrays, select the JSON-mode schema column itself. Nested selection objects and Drizzle's relational query API are outside this first adapter.

Date/timestamp modes, numeric modes, BLOB/bigint columns, custom column decoders and `.mapWith()` are rejected explicitly rather than silently skipping their conversions. Convert such fields to a supported scalar in an aliased SQL expression when appropriate. Unbound `sql.placeholder()` values are not supported; bind actual values in the query before exporting. The adapter reads a few runtime metadata properties that Drizzle marks internal, including configured casing, selection fields and SQL decoders; compatibility tests cover the pinned version and upgrades should rerun them.

`zip`, `signal`, `output`, `end`, `bufferSize` and `.result` work as in the core API, using the same writer and ZIP implementation. Table `encoding` applies to native connections; remote exports always receive UTF-8 protocol text. The caller owns the connection. Drizzle transaction-wrapper objects do not expose the required `$client`; for local connections, pass the original database while its native transaction remains open for the entire export consumption. Remote exports share one dedicated export session per client and cannot join a caller's transaction.

For Turso, create the client using `exportlite/turso` as shown below. Other Drizzle drivers are not supported. Run `node examples/drizzle.mjs` for local table, select and raw SQL examples.

The [Drizzle adapter benchmark](benchmarks/DRIZZLE-ADAPTER.md) compares total JSON generation/UTF-8 output time and whole-process peak memory against direct ExportLite and normal Drizzle queries plus `JSON.stringify()`, using the existing fixtures and Node 26.12.0. It includes separate select-builder and Drizzle-loaded application controls.

## Turso / libSQL HTTP

Use the `exportlite/turso` client factory for both direct exports and Drizzle. It returns the official `@libsql/client/http` client with an awaitable `close()`, retaining the transport configuration needed for streaming exports. Existing applications can change their client factory import; an already-created SDK client does not expose that configuration publicly. Ordinary SDK and Drizzle queries keep their own execution paths and do not use the cached export session.

```ts
import { integer, text } from "exportlite";
import { createClient, exportTable, exportQuery } from "exportlite/turso";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const stream = await exportTable(client, "users", {
  columns: { id: integer().primaryKey(), displayName: text("name") },
  format: "json",
  zip: true,
});
// Keep client open until consumption and stream.result have completed.
return new Response(stream, { headers: { "Content-Type": "application/zip" } });
```

Direct remote exports require a typed `columns` object, for both tables and queries. Queries accept the same `sql` and positional/named `params` as local exports. A single declared integer primary key enables 256-row table batches; other keys and queries use row streaming. Files and Node writable destinations work with `output` as usual.

Drizzle supplies the column declarations and primary-key metadata:

```ts
import { drizzle } from "drizzle-orm/libsql/http";
import { exportTable, exportQuery } from "exportlite/drizzle";
import { createClient } from "exportlite/turso";
import { users } from "./schema";

const client = createClient(config);
const db = drizzle(client);
const stream = await exportTable(db, users, { format: "json" });
// exportQuery(db, db.select(...).from(users), options) also works.
```

Each healthy export sends **one SQL statement in one streaming [`/v3/cursor` request](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md), with no schema, version, column-discovery or capability preflight**. The first cursor implicitly opens the session. Subsequent successful exports reuse its latest server-issued baton. A separate `/v3/pipeline` close request runs once at client shutdown, rather than after every export. SDK `execute()` and Drizzle result buffering are bypassed.

The current [Turso HTTP protocol](https://github.com/tursodatabase/turso/blob/main/serverless/PROTOCOL.md#43-stream-retention) retains cursor sessions until explicitly closed or expired and permits only one request at a time per session. Exports therefore queue on that client's dedicated export session. The queue is acquired when consumption starts and held through output completion and disposal. A slow consumer delays other exports on the same client; separate clients remain independent. Queue waiting is included in `durationMs`. Cancelled queued exports make no HTTP request and create no output file. An unused readable acquires no queue slot.

Every completed SELECT still has its own read snapshot; the reusable session does not open a surrounding transaction or retain exported records. Backpressure pauses cursor consumption. Cancellation, output errors, SQL errors and interrupted/malformed responses discard the session and attempt cleanup before the queue advances. Owned partial files are removed and the original export error is preserved. The next export starts a fresh session. There are no keep-alive queries or background timers.

Idle sessions can expire independently of the JavaScript client. When a reused cursor request is rejected with HTTP 404, or legacy HTTP 400 carrying `STREAM_EXPIRED`, ExportLite clears the old session and makes at most one fresh-session attempt against the original URL. Recovery happens before any cursor header or row has been accepted. This can add one failed HTTP request but no metadata preflight. Network errors, other HTTP errors, SQL errors and partial response bodies are never automatically replayed. An already-expired session needs no further cleanup.

Call **`await client.close()`** at application shutdown or when the client is no longer needed. It marks the SDK client closed immediately, aborts active and queued exports (including output waits), waits for their cleanup, then closes the retained remote session with a five-second timeout. Repeated closes share the same promise. Remote cleanup failures reject that promise; completion of an earlier successful export is unaffected, and its valid output file remains. Ignoring the promise starts shutdown but does not confirm completion. `await client.reconnect()` aborts and drains export work, closes the old session and reopens the SDK client with no cached baton. ExportLite never closes the caller's client automatically. On a broken network, server-side expiry remains the final cleanup mechanism.

Protocol JSON is decoded one frame at a time; exported JSON fragments are not parsed into records. The remote path uses text rather than base64-encoded SQLite BLOBs, so no database-encoding probe or hint is needed, including for UTF-16 source databases. Output is always UTF-8. As with local batches, unusually large records can require substantial memory; network, server and stream buffers also contribute. SDK `intMode` changes ordinary SDK reads, not SQLite's JSON integer literals.

Remote options and bindings are checked before returning a readable. SQLite validates the actual statement when consumption starts, so missing columns and SQL errors reach the body and `.result` with `SQLITE_ERROR`. HTTP and malformed-protocol failures use `REMOTE_ERROR`; cancellation uses `ABORTED`. Successful export `.result` covers output completion; remote client-lifetime cleanup is covered by `await client.close()`. The shared ZIP settings, output ownership and failure cleanup apply unchanged. This adapter runs in Node; it does not add browser or edge-runtime support.

Tested with `@libsql/client` **0.18.0**, the current npm version checked October 18, 2026. Local protocol tests use a real HTTP server backed by SQLite and cover both direct and Drizzle exports. **Live Turso Cloud compatibility and remote performance have not been verified.** Run `node examples/turso.mjs` against an existing database containing `users(id, name, active)`, with `TURSO_DATABASE_URL` and optional `TURSO_AUTH_TOKEN` in its environment. The example only reads that database.

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

Options are validated before the readable is returned. Local connections also prepare and validate SQL at that point; remote SQLite validation occurs when consumption starts. The export data statement starts when reading begins, and backpressure pauses further rows/batches. The read snapshot starts with consumption. Cancelling the stream or its reader, stopping async iteration, or aborting `signal` cancels production and releases the statement or remote cursor and owned ZIP stages. `await stream.cancel()` waits for that cleanup. For a Node pipeline, use Node's built-in `Readable.fromWeb(stream)` adapter; it forwards failures and cancellation between the two stream interfaces. The caller retains ownership of the database client.

Keep that connection open until `stream.result` settles. Read or pipe the stream before awaiting `.result`; the promise waits for consumption and export cleanup. Statistics count the exported bytes, including ZIP headers/trailer when enabled, and do not mean an HTTP client has received them. For readables, `durationMs` includes elapsed time waiting for consumption. If using a connection per request, close it from the completion callbacks rather than immediately after returning the `Response`.

Row-time SQLite and ZIP failures reach both the readable and `.result`. Cancel unused streams with `await stream.cancel()`; when a reader holds the stream's lock, use `await reader.cancel()` instead. The package observes its internal completion rejection so applications that only consume the body do not acquire an unhandled promise rejection. `end` applies only to a provided destination and is rejected when `output` is omitted. Run `node examples/readable.mjs` for a ZIP response consumed through a file pipeline.

Frameworks that accept Web `Response` objects can use these examples directly, provided the route runs in Node with access to the SQLite connection. For tRPC applications, use a normal authenticated download route for the export bytes; a typed tRPC procedure can return its URL and filename. tRPC's [`httpBatchStreamLink`](https://trpc.io/docs/client/links/httpBatchStreamLink) streams values through its own JSON protocol rather than serving the raw ZIP or JSON download. ExportLite returns bytes; its optional column declarations describe TypeScript row types, while SQLite schemas and SQL strings alone do not provide inferred row types.

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

Internally, ZIP uses one continuous DEFLATE stream, compression level **1**, `memLevel: 9`, a **256 KiB zlib output buffer**, and ZIP64 support. These settings prioritize export speed and keep the API small. `bufferSize` still controls the uncompressed UTF-8 flush target; it does not configure compression or cap memory. The archive adds bounded stream buffers and checksum work. Empty exports still produce a valid archive containing `[]` or an empty JSONL file.

`bytesWritten` counts the complete ZIP file, including its headers, checksum descriptors and directory. Completion waits for the directory and last destination write, plus stream finalization when `end: true` is requested. Backpressure, cancellation, output ownership and partial-file cleanup follow the same rules as plain exports. A cancelled or failed archive is incomplete; caller streams can already contain ZIP bytes. Files created by the package are removed on handled failure.

Run `node examples/zip.mjs` for a working ZIP export. The [actual ZIP benchmarks](benchmarks/ZIP.md) compare the public option with JS object streaming using the same ZIP writer and settings.

The [naive JavaScript comparison](benchmarks/NAIVE.md) adds `all()` followed by `JSON.stringify()` of the complete row array, with plain JSON and ZIP output. It measures total time, encoded size and peak memory alongside both streaming implementations on the same varied fixtures.

## Fixed batching and streaming fallbacks

Automatically discovered local tables use 256-row batches when a usable rowid exists. Declared tables use the same batching algorithm when one integer primary key is supplied. One recursive export statement finds indexed key ranges and builds a JSON array or LF-separated objects per range. JavaScript joins those fragments directly. There are no SQL callbacks, sizing estimators or pagination queries. Native exports use the supplied connection; Turso exports serialize on their client's reusable export session. For local exports using discovery, SQLite version and JSON capability checks run once after the first successful check per connection. Declared tables and queries rely on the final JSON statement, without preflight probes.

Repeated table exports reuse generated SQL, with at most 16 cached plans per connection shared by declared and discovered plans. A schema-version check invalidates discovered plans after schema changes; declared plans depend only on the request. Each export prepares an independent statement, so overlapping and lazy streams keep separate iterators. Rows and response bytes are generated afresh. Custom queries discover their output columns unless `columns` is declared.

Each range starts with an indexed seek and locates its 256th existing key using a constant `OFFSET 255`. That offset stays fixed for every batch; it does not grow with the export. Bounds remain SQLite integers, and only a short final batch needs a separate count inside the same statement.

For local UTF-8 databases, batch JSON stays as UTF-8 bytes from SQLite through the writer, avoiding conversion to JavaScript text and back. Local UTF-16 databases and remote connections use text and still produce UTF-8 output. This is internal; the stream and file APIs are unchanged.

With automatic discovery, views, virtual tables, WITHOUT ROWID tables and tables shadowing all three rowid aliases use row streaming. Declared selections choose batching from the declared key, without storage discovery. Custom queries always stream individual SQLite-generated JSON records. Both paths share the output loop, backpressure, cancellation and cleanup. An execution failure never retries another path after writing partial data.

Batched tables are exported in ascending key order: the declared integer key, or the discovered rowid. Fallback order follows SQLite; use a query with ORDER BY when ordering is essential. The active statement preserves one read snapshot while waiting for output. ExportLite does not manage caller transactions or open/close the connection.

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
- Query parameters are bound. Local writes, PRAGMAs, multiple statements and duplicate output aliases are rejected before opening output. Remote queries wrap the supplied SELECT/CTE inside the final JSON SELECT; server-side validation happens during consumption. Query SQL is trusted application code, not a sandbox for functions with side effects.
- SQLite constructs strings, NULLs and numeric literals. JSON stored as TEXT stays a string. Exact signed 64-bit integer literals are preserved, including with a BigInt-configured connection; ordinary `JSON.parse()` consumers can still lose precision. REAL formatting remains SQLite's own.
- BLOBs fail with a descriptive error. Select other columns or use an explicit query with `hex()`/`CAST()`.
- Empty JSON is `[]`; empty JSONL is zero bytes. Export failures are `ExportLiteError` instances with a `code` and original cause where available.

SQLite >=3.45.1 with JSON support is required. Automatic local discovery checks this on the first export per connection; declared and remote exports skip capability probes and rely on the final statement. Do not close or mutate the same connection while an export is running. Queries may sort/materialize data within SQLite; long read snapshots can affect writers and WAL growth.

## Development and validation

Use Node.js 22.18+, 24.11+, or 26+ for the development tools and pnpm 12.14.0. Tested on Node 24.19.0 and 26.12.0. Dependency versions were rechecked on October 18, 2026: `better-sqlite3` 13.0.3, Drizzle 0.45.4, `@libsql/client` 0.18.0 and `zip-stream` 7.0.5 remain current. Node typings stay on the pinned 22.x line to match the intended minimum runtime. Direct development dependencies are pinned in the lockfile. tsdown warns that its TypeScript 7 compiler-API integration is experimental; declarations and typed consumers are checked locally.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check
pnpm example
```

Local checks cover 378 tests, ESM/CommonJS consumers, declared column builders and aliases, inferred row contracts, 256-row boundaries, all fallback kinds, parameter binding, Unicode/NULL/integer preservation, backpressure, cancellation, finalization, partial-file cleanup and concurrent WAL snapshot consistency. Declared-column tests also cover one-statement queries without metadata reads, quoted and case-distinct JSON keys, repeated source columns, boolean encoding and schema changes. Readable tests cover lazy execution, one data statement, Web `Response` bodies and writable streams, Node pipelines, cancellation/disconnects, errors and completion statistics. ZIP tests additionally decode archives with an independent reader, check CRC-32 and encoded byte statistics, and exercise footer-write errors. Cache tests cover data updates, schema changes from another connection, rolled-back DDL, cache eviction, overlapping lazy streams, cancellation, failed outputs and capability-check retries. Turso tests additionally cover actual local HTTP cursors, request counts, fragmented Unicode protocol frames, interrupted responses, malformed messages, session reuse and serialization, queued cancellation, expiry recovery without partial-stream replay, awaited shutdown and cleanup errors, client close/reconnect and the public example. Optional-peer tests check that unused drivers need not be installed. A separate `node benchmarks/validate-zip64.mjs` check streamed and fully decoded an actual entry larger than 4 GiB. A cross-version CI matrix has not yet been run. Run `node examples/batched.mjs` for a larger table export using the same API.

## Benchmarks

The [phase 2 regression checks](benchmarks/PHASE-2.md) cover the shared delivery refactor, plain/ZIP output hashes, targeted timing rechecks and the observed wide-query peak-RSS shift.

Build first, then compare the public table/query APIs with JS object streaming and full SQLite aggregation:

```sh
pnpm bench --rows=1000000 --width=32 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-narrow.json
pnpm bench --rows=100000 --width=1024 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/v0-wide.json
node benchmarks/report.mjs
```

[Measured results and limitations](benchmarks/REPORT.md).

The [reusable Turso session comparison](benchmarks/TURSO-SESSIONS.md) repeats the same varied fixtures, Node 26.12.0 and 0/25/100 ms simulated latency after adding serialized session reuse. It compares export time and client-process peak memory across all four methods, measures awaited client shutdown separately, and compares with the [previous per-export close implementation](benchmarks/TURSO.md). Both runs use a local protocol server with SQLite; live Turso Cloud performance remains unverified.

The [concurrent Turso comparison](benchmarks/TURSO-CONCURRENCY.md) measures one shared client versus separate clients at concurrency 1, 2 and 4, using those same fixtures, runtime and latency settings. It covers the direct API and Drizzle adapter, reporting throughput, per-export latency including queue wait, and whole-client-process peak memory. The report explains the local fixture server's limits on large-export parallelism.

The [matched API comparison](benchmarks/MATCHED-API.md) reruns the original users/posts/comments fixture on Node 26.12.0, separating JSON generation/pipeline work from UTF-8 response-body encoding for full SQLite aggregation, ExportLite batching, manual JS and Drizzle. It includes actual public Node writable/Web stream controls. Nested and limited-root cases use a benchmark-only adapter around the existing planner/producer; they do not add public relationship support.

The earlier [streaming gzip comparison](benchmarks/COMPRESSION.md) measures ExportLite and JS object streaming with no compression, gzip level 1 and default gzip, including total file-completion time, encoded size and peak memory. Gzip lives entirely in that benchmark harness and uses Node's built-in `createGzip()`. Reproduction commands and raw runs are linked in that report.

The [varied-data comparison](benchmarks/VARIED-COMPRESSION.md) repeats those runs with seeded synthetic business records: distinct references, international names, variable-length support notes, NULLs and occasional longer notes. It includes measured note-size distributions, distinct-value counts and sample records. The earlier repetitive fixtures remain available as a separate comparison.

The [compression-buffer investigation](benchmarks/GZIP-INVESTIGATION.md) tests why large-record compression can hide ExportLite's speed advantage. Using `createGzip({ level: 1, chunkSize: 256 * 1024 })` improved the tested streaming pipeline without changing the export engine or compression ratio. This is the compressor's output-buffer size, separate from `bufferSize` and the stream's queue threshold. The report includes paired comparisons, rejected alternatives and limitations.

Benchmark tools and results are not shipped in the npm payload. CSV, relationship nesting, extra drivers and additional sizing controls are outside v0.

MIT licensed.

The [batch profiling report](benchmarks/BATCH-PROFILE.md) measures the boundary-query optimization against the preserved implementation and full SQLite aggregation on the same Node runtime and fixtures.

The [remaining-gap investigation](benchmarks/REMAINING-GAP.md) measures the UTF-8 byte path against the previous text path and full aggregation returning either text or bytes. It also documents the higher small-record process RSS and lower large-record RSS observed with byte buffering.
