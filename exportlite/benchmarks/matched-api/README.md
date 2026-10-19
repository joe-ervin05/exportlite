# Matched JSON response benchmark

This harness reruns the original users → posts → comments fixture on **Node 26.12.0**, better-sqlite3 **13.0.3**, Drizzle **0.45.4**, and SQLite **3.53.4**. The dependency versions were checked against npm on October 17, 2026 and still match the original benchmark. The isolated package/lockfile prevents the Node 26 native SQLite driver from replacing a different runtime's driver in the main checkout.

The fixture contains 1 million users, 2 million posts, and 4 million comments. Every relationship has two children. The original 21 cases cover 1–1,000,000 root users and 0–2 nested array levels; responses retain the original fields, order, short ASCII values, and complete JSON SHA-256 digests. `reference/` contains unchanged original query, schema, fixture, validation, and summary files. The database itself is not distributed.

## Run

From the package root, install/build the regular package and compile the benchmark-only engine entry:

```sh
pnpm install --frozen-lockfile
pnpm build
node benchmarks/matched-api/build.mjs
cd benchmarks/matched-api
npm ci
node run.mjs
```

Use Node **26.12.0** for the benchmark dependencies and runner. The runner checks that exact version. By default, it builds the original fixture at `work/fixture.db` and writes results to `../results/matched-api/`. Pass `--db=/absolute/path/fixture.db` to reuse a disposable copy of the original fixture. `ensureFixture()` checks all row counts, indexes and fixture metadata before each run; it may checkpoint the database. Do not point it at an application database.

The recorded run used a copy of the original database under `/private/tmp`, leaving the original artifacts untouched. To run a quick independent smoke matrix:

```sh
node run.mjs --sizes=1,100 --depths=0,1,2 --repeats=1 --out=../results/matched-api-smoke
```

There are **267 sequential fresh workers** in the full run: 21 cases × 4 main methods × 3 workers, plus five controls × 3 workers. Workers run without raised heap limits or explicit garbage collection. The runner rotates method order and verifies source/configuration fingerprints before resuming with `--resume=1`. One worker's full result is hashed outside measured rounds and matched against the original summary; every timed response checks its byte count.

## Methods and the ExportLite adapter

- `sqlite`: the unchanged original full SQLite JSON aggregate, returned as one JavaScript string.
- `manual`: the unchanged original `.all()`/grouping/`JSON.stringify()` implementation. Flat responses do not perform unnecessary grouping.
- `drizzle`: the unchanged original prepared relational Drizzle query plus `JSON.stringify()`.
- `exportlite`: the existing ExportLite batch planner and producer, with 256 roots per batch. Queries are prepared before timing, like the three baselines.

ExportLite does not currently expose nested relationships or a table row limit in its public API. For those cases, `root-sql.mjs` adapts the actual planner's SQL: it inserts the original root JSON expression, exposes the root alias to correlated child expressions, and bounds the contiguous fixture rowids to the requested root count. The child SQL remains exactly the original SQL. This is one recursive data statement and the unchanged `streamExport(..., batched=true)` implementation, not a new public feature. For the complete million-user flat table, the adapter returns the unmodified package planner statement.

Additional controls run `exportlite-rows` on each million-root shape to measure the unchanged per-root streaming fallback. The million-user flat case also measures the actual public `exportTable()` API with a Node writable (`public-table-256`) and with its default Web stream (`public-web-table`). The latter is a total-only control because its byte conversion occurs inside the native stream implementation.

## What each phase means

All phase-split methods write to the same immediate in-memory Node writable, with `decodeStrings:false`. Its write callback explicitly runs `Buffer.from(jsonChunk, "utf8")` and measures just that synchronous conversion, including byte-buffer allocation. Complete-value methods supply one string; ExportLite supplies its normal buffered strings. Encoded buffers are discarded after the callback. There are no socket, disk, compression, ZIP, TLS, browser parsing or tRPC envelope costs.

- **Encoding:** sum of UTF-8 conversion intervals across that response's chunks.
- **Generation/pipeline:** total response-production time minus encoding. This includes SQL execution, driver conversion, required mapping/stringification, and producer/writable coordination. ExportLite additionally retains its real byte-length accounting, safety checks, stitching and cooperative event-loop yields. It is not an isolated SQLite-only measurement.
- **Total:** producer start through sink completion. For the public Web control, start through body consumption and `stream.result` completion.

Most query planning and all statement preparation are excluded from the main four methods. The explicitly named public controls include their normal validation/planning. Sink construction, process/module startup, fixture setup, hashing and structural validation are excluded. Measured encoding allocations can affect later garbage collection, so generation components need not exactly reproduce an older string-only run.

Small responses warm up 100 times; 10,000 roots warm up 10 times; larger cases warm up once, in addition to an untimed verification response. Adaptive iteration counts target 40 ms of work per batch. Each worker records five batch means below 100,000 roots and three at larger sizes. The worker reports its median-total batch and corresponding phase times. The summary reports the median-total worker and its corresponding phases, so generation plus encoding equals total. Min/max are ranges of process-level medians, not confidence intervals or request percentiles. Peak RSS includes startup, verification and warmups; it is context, not a per-request allocation.

After the benchmark, regenerate the Markdown report and optional scientific figure:

```sh
node report.mjs
python3 plot.py
```

The plot needs Matplotlib. Raw worker samples, source/fixture hashes, SQL, versions, JSON digest checks, CSV and summary live in `../results/matched-api/`. The smoke runs are diagnostic and are not mixed into the final results.
