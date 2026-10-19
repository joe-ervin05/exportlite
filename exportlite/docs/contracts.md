# API and data contracts

This is the supported API contract for the current prototype. See the [compatibility checks](compatibility.md) for Node/platform qualification. Release qualification and live Turso verification remain separate work. The public API stays small: `exportTable()`, `exportQuery()`, column declarations and the optional adapters.

## Entry points and execution

| Entry point | Connection | Table selection | Query selection |
| --- | --- | --- | --- |
| `exportlite` | Caller-owned better-sqlite3 connection | Automatic discovery, column-name list, or ExportLite declarations | Trusted SELECT/CTE with positional/named parameters; optional declarations |
| `exportlite/drizzle` | `drizzle-orm/better-sqlite3`, or the registered Turso client through `drizzle-orm/libsql/http` / `drizzle-orm/libsql` | Existing SQLite table, optionally selected/renamed schema columns | Unexecuted flat select builder, or raw `sql` with explicit schema-column metadata |
| `exportlite/turso` **experimental** | Client created by `createClient()` from this entry point | Required ExportLite declarations | Required SQL and ExportLite declarations |

Other Drizzle drivers, nested selections and the relational query API are unsupported. The Drizzle adapter targets `>=0.45.4 <0.46.0` and is tested with 0.45.4; wider compatibility is not established. Its export path bypasses Drizzle row decoders, result caching and query logging hooks. Select filters still use Drizzle's SQL and parameter encoders. A cached SQL plan never caches exported rows.

| Selection | Metadata work before the data statement |
| --- | --- |
| Automatic local table or column-name list | Initial SQLite/JSON capability checks; table/storage/encoding discovery on a plan miss; schema-version checks for invalidation |
| Automatic local query | Initial capability checks and preparation of the source SELECT to discover result columns; then preparation of the formatted data statement |
| Declared local table/query or either Drizzle adapter | Zero schema, schema-version, capability or result-discovery preflight queries; prepare the final data statement locally |
| Direct Turso | Zero metadata preflight requests; send the final data statement when consumed |

Eligible tables use fixed 256-row batches in one export statement. Automatic local tables use a usable rowid; declared tables use one declared integer primary key; Drizzle can obtain an unselected key from its schema. Other tables and all custom queries stream individual SQLite-generated records. Batches sort by their key; use an explicit query `ORDER BY` for other ordering requirements.

`.primaryKey()` declares an **existing unique, non-null key**. It does not create or verify a constraint or index. The key should be indexed. Incorrect declarations can omit records; declaration builders are not a substitute for database constraints. `.notNull()` and scalar types are also caller contracts, without per-record JavaScript validation or coercion.

## Return values and lifecycle

Both APIs return promises. Omitting `output` resolves to `ExportStream<Row>`, a Web `ReadableStream<Uint8Array>` with `.result: Promise<ExportResult>`. Providing a new file path or byte-mode Node writable resolves to `ExportResult` after delivery and cleanup. The default format is **JSONL**; every JSON array response must specify `format: "json"`.

| Option | Contract |
| --- | --- |
| `format` | `"jsonl"` by default; `"json"` emits one array; `"csv"` emits a header and records |
| `zip` | `false` by default; `true` emits one JSON/JSONL/CSV file inside a streaming ZIP |
| `output` | Omit for a Web stream; supply an exclusive new path or caller-owned Node writable |
| `signal` | Cancels production, queued remote work and output waits; use an application deadline if needed |
| `end` | Only with a supplied destination; caller writables stay open by default |

The existing `encoding` and `bufferSize` options are described in [advanced options](advanced.md). Encoding describes the SQLite database; buffer size is an output flush target.

`ExportResult` contains `rowsExported`, `bytesWritten` and `durationMs`. Bytes count actual output, including ZIP headers/trailer, and do not establish delivery to an HTTP client. For Web streams, duration includes waiting for consumption. ZIP table entries use a sanitized table name; query entries use `export.json`, `export.jsonl` or `export.csv`. CSV headers count toward bytes, but not rows.

1. Column builders can throw while declarations are created. Await the export call to validate options, selections and bindings. Local calls also prepare SQL and detect preparation errors. Remote statement validation happens at the server during consumption.
2. Consume or pipe the returned stream **before awaiting `.result`**. The data statement starts on the first read, not when the readable is returned. In autocommit mode its read snapshot starts then; a caller's existing local transaction can already have a snapshot.
3. Keep the connection open until `.result` settles. Cancel an unused stream with `await stream.cancel()`. If a reader owns the lock, use `await reader.cancel()`. Node pipelines can use `Readable.fromWeb(stream)` and forward cancellation to it.

For destination calls, production begins within the call and the returned promise covers completion. Files are created exclusively, removed on handled failure, and visible while being written. Caller-owned streams are not destroyed on failure and may contain partial output. An abrupt process exit can leave a partial file.

Before HTTP headers are sent, a handler can translate an export-call rejection into an error response. After returning the response, a row-time SQLite, network or ZIP failure errors the body and rejects `.result`; it cannot replace sent bytes with a new JSON error or status. Observe `.result` to log completion/failure, propagate request cancellation, and let the server terminate the failed response. Do not append an error object to partial JSON or ZIP bytes.

```ts
import { exportTable } from "exportlite";

const stream = await exportTable(db, "users", {
  format: "json",
  signal: request.signal,
});
void stream.result.then(
  (stats) => console.log(stats),
  (error) => console.error("Export failed", error),
);
return new Response(stream, {
  headers: { "Content-Type": "application/json" },
});
```

Here `db` is application-owned and remains open. If the handler creates its own connection, close it in both completion callbacks; also close it if the export call rejects before a stream is returned.

Errors use `ExportLiteError.code`: `INVALID_OPTIONS`, `INVALID_QUERY`, `INVALID_SCHEMA`, `UNSUPPORTED_SQLITE`, `SQLITE_ERROR`, `REMOTE_ERROR`, `OUTPUT_ERROR` or `ABORTED`. Codes distinguish categories, not an exact timing guarantee for every SQLite failure. Invalid stored booleans, malformed JSON-mode text and BLOB values can fail only when read. Never assume a returned readable guarantees that all records are valid.

Remote failures also expose `status` and `providerCode` when available. Transport/response-decoding cause chains retain up to two error categories and bounded diagnostic codes, without arbitrary messages, original stacks or attached request data. HTTP error bodies and free-form provider messages are not copied into errors. Application-provided output and cancellation causes retain their existing behavior.

Execution/output errors take precedence if cleanup also fails; cleanup is still attempted. A partial file can remain if the filesystem prevents its deletion. Failure to close a remote client after a successful export does not invalidate or delete that completed output.

The active statement preserves its snapshot while output pauses. Local exports use the supplied connection and can run inside an already-open native transaction, which must stay open for the complete consumption. Do not return a lazy stream from a synchronous `db.transaction()` callback and consume it after that callback ends. Drizzle transaction-wrapper objects lack the required `$client`; pass the original Drizzle database while its native transaction remains open. Remote exports use a separate session and **cannot join a caller's transaction**.

## Field modes and wire types

| Source or mode | Direct declaration / wire value | Drizzle adapter |
| --- | --- | --- |
| Nullable TEXT, including Unicode | `text()` → string or null | Plain/enum `text()` supported; enum constraints are not validated by ExportLite |
| INTEGER / REAL | `integer()` / `real()` → JSON number or null | Plain integer/real supported |
| Boolean stored as 0/1 | `integer({ mode: "boolean" })` → false/true/null; other values fail while reading | Boolean integer mode supported with the same strict rule |
| JSON stored as TEXT | `text()` keeps an escaped JSON string; automatic discovery does the same | `text({ mode: "json" })` embeds JSON; malformed values fail while reading; `$type<T>()` does not validate their shape |
| Dates / integer timestamps | Convert in SQL; declare the ISO result with `text()` | `timestamp` / `timestamp_ms` rejected as selected columns; select an aliased SQL string expression |
| Large signed 64-bit INTEGER | Exact JSON digits; cast to TEXT for an exact identifier string | Plain integer emits digits; bigint-configured SDK reads do not change the JSON wire format |
| BLOB, including bigint/JSON BLOB modes | Raw BLOB fails while reading; convert deliberately in SQL | All BLOB modes rejected before statement preparation |
| NUMERIC / decimal | Select a deliberate TEXT or REAL conversion, matching the wire contract | All numeric column modes rejected; use an aliased SQL scalar |
| Custom decoder / `.mapWith()` | Express a supported scalar conversion in SQL, or perform decoding outside ExportLite | Selected custom column types and `.mapWith()` expressions rejected before preparation |

SQLite has flexible storage types. `text()` does not cast a stored number to a string, and `.notNull()` does not check every stored value. Without a boolean/JSON mode declaration, discovery uses SQLite's raw scalar representation. BLOB parameters are allowed where a query converts them to a supported output value; Date and boolean objects are not core SQL bindings. Use numeric timestamps and 0/1, or Drizzle's parameter encoders.

JavaScript `JSON.parse()` can round integer literals outside the safe integer range even when their digits were exported exactly. `CAST(id AS TEXT)` preserves signed 64-bit identifiers as strings. A Drizzle `blob({ mode: "bigint" })` has a different storage representation: casting its bytes is not a generic bigint decoder. Choose a conversion that matches the actual stored format.

JSON has strings, numbers, booleans, null, arrays and objects; it has no Date or BigInt value. `string | null` is a TypeScript contract allowing either JSON representation. An ISO timestamp's wire type is `string`, not `Date`. `ExportRow<typeof stream>` / `InferColumns` describe these row contracts; the stream still contains bytes, including archive bytes for ZIP. Neither `Response` nor tRPC automatically inherits that row type. A client needs an explicit shared HTTP contract or validation, and `response.json()` still materializes the full body.

## CSV

All entry points support `format: "csv"`, including query bindings, column aliases and `zip: true`. Headers follow selection order and use output keys. Empty results still include the header. There are no delimiter, header, BOM or formatting options in this version.

| Value | CSV representation |
| --- | --- |
| Header / TEXT | Double-quoted; every `"` is doubled, commas and embedded CR/LF are preserved |
| SQL NULL | Unquoted empty cell |
| Empty TEXT | `""` |
| INTEGER / REAL | SQLite `CAST(value AS TEXT)` representation; exact integer digits |
| Declared boolean | `true`, `false`, or empty for NULL; invalid stored values fail |
| Drizzle JSON-mode TEXT | Canonical SQLite JSON text inside a quoted cell; malformed JSON fails |
| BLOB | Rejected; select an explicit SQL conversion |

Records end with CRLF, including the final record. Output is UTF-8 without a BOM. A normal CSV parser returns string cells and treats both NULL and empty text as an empty string; CSV does not retain JSON's typed-null distinction. SQLite REAL formatting can differ from JavaScript number formatting. `ExportRow<typeof csvStream>` maps selected fields to strings, including nullable numbers and booleans; `InferColumns` continues to describe the source/JSON contract. Streams with undiscovered row types stay unknown.

Text is exported unchanged, including formula-looking cells. Quoting handles CSV syntax; applications that need modified spreadsheet cell contents should select those contents deliberately in SQL. No JavaScript per-row transformations or new runtime dependencies are added.

CSV uses the existing fixed table batches and writer, including native UTF-8 byte batches. Query/fallback records have a streaming SQL boundary so inspecting and escaping computed values does not reevaluate the source expressions. Source queries can still sort or materialize internally as described under streaming limits. Backpressure, cancellation, snapshots, exclusive files, error cleanup and remote session ownership have the same contracts as JSON/JSONL.

## SQL conversion recipes

Convert before ExportLite constructs JSON. These recipes preserve SQL NULL, including `hex(NULL)`, which would otherwise become an empty string.

| Desired wire value | SQLite expression | Declaration / Drizzle SQL type |
| --- | --- | --- |
| Exact integer identifier | `CAST(id AS TEXT)` | `text().notNull()` for a non-null source / `sql<string>` |
| UTC ISO timestamp from epoch seconds | `strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')` | `text()` / `sql<string \| null>` |
| UTC ISO timestamp from epoch milliseconds | `strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')` | `text()` / `sql<string \| null>` |
| BLOB as hex text | `CASE WHEN payload IS NULL THEN NULL ELSE hex(payload) END` | `text()` / `sql<string \| null>` |
| Decimal storage as text | `CAST(amount AS TEXT)` | `text()` / `sql<string \| null>` |
| Approximate numeric value | `CAST(amount AS REAL)` | `real()` / `sql<number \| null>` |

Date conversion can return null for out-of-range inputs. SQLite NUMERIC affinity may already have rounded a decimal; casting cannot recover lost precision. Store exact decimal strings as TEXT when that is the required contract. Custom storage formats need their own deliberate SQL conversion.

```ts
import { sql } from "drizzle-orm";
import type { ExportRow } from "exportlite";
import { exportQuery } from "exportlite/drizzle";

// records is an existing Drizzle SQLite schema, with a timestamp_ms column.
const query = db.select({
  id: sql<string>`CAST(${records.id} AS TEXT)`.as("id"),
  createdAt: sql<string | null>`strftime(
    '%Y-%m-%dT%H:%M:%fZ', ${records.createdAt} / 1000.0, 'unixepoch'
  )`.as("createdAt"),
}).from(records);
const stream = await exportQuery(db, query, { format: "json" });
type Row = ExportRow<typeof stream>; // { id: string; createdAt: string | null }
```

Use `.as(...)` for computed selections. A `sql<T>` annotation describes the expression's actual wire value; it does not run a decoder or check it. For nested JSON objects/arrays, select the JSON-mode schema column itself.

The [executable conversion example](https://github.com/joe-ervin05/exportlite/blob/main/exportlite/examples/data-contracts.mjs) checks direct and Drizzle exports with nulls, Unicode, ISO timestamps, hex BLOBs, JSON text and an exact large identifier. After building the checkout, run `node examples/data-contracts.mjs`. Public type consumers separately check the ISO-string and identifier-string contracts.

## Remote session lifetime and admission

Turso support remains experimental pending live qualification. A healthy export uses one data request containing one SQL statement, without metadata requests. One reusable export session belongs to each registered client. Exports serialize on it and retain ownership through producer output completion and cleanup, including destination backpressure and ZIP finalization. Creating a lazy readable does not reserve the session; consuming it does. `.result` additionally waits for Web consumption. Independent clients permit concurrent exports; ordinary SDK queries use their own path.

The package's queue is not an admission limit. A cancelled queued job rejects with `ABORTED` without starting its data request or closing the active export's session. Reuse of an expired session gets at most one fresh-session retry on a recognized expiry response before cursor data begins. Network failures, SQL failures and partially streamed cursor responses are not replayed. JSON/ZIP framing may already have reached the destination; retrying a rejected old session does not restart the output writer.

Apply admission and deadlines in the application, keeping any permit until output completes. This single-process example allows one file export at a time; use a coordinated application policy if multiple server processes share a budget.

```ts
import { integer, text } from "exportlite";
import { exportTable } from "exportlite/turso";

let exporting = false;
async function saveExport(path: string, requestSignal: AbortSignal) {
  if (exporting) throw new Error("An export is already running.");
  exporting = true;
  try {
    return await exportTable(client, "users", {
      columns: { id: integer().primaryKey(), name: text() },
      format: "json",
      output: path,
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]),
    });
  } finally {
    exporting = false;
  }
}
```

Create the client at application startup with `createClient()` from `exportlite/turso`, including when using Drizzle. Keep it open across requests and use `await client.close()` at shutdown. Close aborts/drains active and queued exports, then closes the cached session; it does not gracefully finish an active download. A shutdown cleanup failure rejects `close()` without invalidating earlier completed output. `await client.reconnect()` aborts/drains export work and reopens without the old session. ExportLite never closes caller clients automatically; unreachable servers may retain sessions until server-side expiry.

## Streaming limits

Fixed batches and flush targets avoid collecting the complete export but are not hard byte or RAM limits. Large records, SQLite sorting/working memory, strings, compression, HTTP/protocol buffers and concurrent jobs all contribute. An individual synchronous local SQLite step cannot be interrupted; cancellation is checked between rows/batches and while awaiting output. Long snapshots can delay writers or grow the WAL. ZIP compression happens in Node after database-to-Node transfer; ordinary HTTP compression stays outside the core package.
