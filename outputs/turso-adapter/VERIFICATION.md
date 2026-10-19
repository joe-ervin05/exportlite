# Turso adapter verification — October 18, 2026

Implemented in `exportlite/`, a private package in a directory without Git metadata. The pre-change package is preserved in `baseline/`; `changes.patch` records source, configuration, test and documentation changes. Generated ESM/CommonJS output is rebuilt in the package's `dist/` directory.

## Public API

- `exportlite/turso`: `createClient(config)`, `exportTable(client, table, options)` and `exportQuery(client, options)`. Direct exports require declared columns.
- `exportlite/drizzle`: existing table, select-builder and raw SQL exports now also accept Drizzle databases constructed with the registered Turso client. Schema columns supply field names, types and primary keys.
- `createClient()` returns the official `@libsql/client/http` client and retains its transport configuration for the export cursor. The caller owns the client. An existing SDK client must be created through this factory to enable exports.

The shared SQL planner retains fixed 256-row integer-key table batches and row-streaming fallbacks. Remote exports use UTF-8 protocol text rather than base64 BLOBs. The existing writer, Web stream bridge and ZIP implementation are reused. No local synchronous producer changes were needed.

## Request behavior

A successful export uses one SQL statement with no metadata or capability preflight:

1. `POST /v3/cursor`: one batch step containing the JSON SELECT.
2. `POST /v3/pipeline`: close the export session; no SQL.

There is no additional round trip before the data request. Closing is awaited before completion and has a five-second timeout. There is no automatic query retry. Every export owns an independent remote read session and cannot join a caller's transaction.

## Results

- **338 tests passed, zero failures**, across 10 test files, on Node 24.19.0 and SQLite 3.53.4.
- ESM and CommonJS builds, declaration generation, public consumer type checks and Biome checks passed.
- Local protocol coverage uses a real HTTP endpoint backed by actual SQLite execution, with 52 Turso tests. It covers direct and Drizzle exports, aliases, JSON/boolean types, bindings, fixed batch boundaries, query and key fallbacks, ZIP decoding, Unicode frame fragmentation, UTF-16 source databases, slow consumers, cancellation, client close/reconnect, destination failures, server errors, malformed/truncated responses, session cleanup and partial-file removal. The public Turso example runs against this fixture.
- Three additional optional-peer tests load built Turso-only, Drizzle-only and combined entries in ESM/CommonJS without `better-sqlite3` installed in the consuming fixture.
- Native direct and Drizzle table exports still prepare exactly the previously measured SQL, one statement each. SHA-256: `65efaace3914bf88b4f9eb70e8621d368d3b4fa44fe48b531d6e07839876e824`.
- Native producer, native driver, writer, Web stream bridge and ZIP source hashes match the pre-change baseline.

Versions checked for this work: `@libsql/client` 0.18.0, Drizzle 0.45.4, `better-sqlite3` 13.0.3. The alternative `@tursodatabase/serverless` SDK 1.4.1 was inspected but not added. The HTTP cursor avoids SDK metadata preflights and buffered execution paths.

**Scope:** local protocol verification only, as requested. No real credentials or live Turso Cloud database were used. Cloud compatibility, latency, server resource usage and remote export performance remain unverified. No new performance benchmark was run. Existing local benchmark results are unchanged historical measurements.

The underlying documented protocol is [Hrana HTTP v3](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md). Request buffering, server and network buffers, and individual large records can still consume memory; fixed row batches do not impose a byte or RAM limit.

Raw test results are in `test-results.json`; other check outcomes are in `checks.json` and `sql-validation.json`.
