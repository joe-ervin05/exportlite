# JS CSV encoder experiment

This experiment substitutes row-by-row JS CSV escaping/joining for local SQLite
CSV construction inside ExportLite. It uses the normal public API and the existing
writer, Web-stream adapter, ZIP pipeline, cancellation and file cleanup. It does
not add an encoder option or change the shipped default. Turso remains on the
SQLite path.

`candidate.patch` applies to commit `6cedfe09ff9853116906a62426cfccc237bac0a8`.
The two new modules contain the encoder and its scalar projection. The remaining
runtime changes connect that projection to local native/Drizzle table and query
plans. A private planner flag keeps the shared Turso planners unchanged. None of
these experimental runtime changes is applied to the normal package sources.

## Contract and fairness

SQLite still validates boolean/JSON fields and returns each cell's storage kind
and canonical text. JS quotes text, doubles embedded quotes, emits numeric text
unchanged, leaves NULL empty and joins cells with commas. This avoids silently
rounding signed 64-bit integers, changing REAL spellings or quoting numerics stored
in a loosely typed column. It is a JS **CSV encoder**, not a pure-JS replacement
for SQLite's scalar conversion. BLOB rejection, primary-key validation/order and
the existing UTF-16 declaration check are retained without another query.

The manual JS control is the unchanged four-field encoder from the previous CSV
comparison. It reads ordinary row objects and uses JS numeric conversion; these
fixtures contain safe integers, text and NULL, so all three outputs match. It does
not implement the package's full validation/ownership/error contract. Do not
interpret the timing difference as encoder overhead alone.

The candidate tests retain the public CSV checks. Six implementation assertions
now check its row SELECT instead of a recursive batch SELECT. The paused-output
tests count rows rather than batches and still require the iterator to stop
before all 2,048 records, stay stopped while the callback is held, cancel
awaitably, preserve caller output ownership and leave the database usable. Two
additional cases cover exact numeric spellings without driver safe-integer mode,
for table/query and plain/ZIP output.

## Reproduce

Install the pinned dependencies in `exportlite/`. From the repository root, use
the same Node 26.12.0 executable used in the recorded comparison:

```sh
BUILD_NODE=/path/to/node24 node exportlite/benchmarks/csv-js/prepare.mjs
node exportlite/benchmarks/csv-js/run.mjs
```

The preparer reads the pinned Git tree into **new** ignored directories at
`outputs/csv-js/projects/{sqlite,javascript}/exportlite`, applies the patch only
to the latter and builds both with the same compiler/runtime. It links the
installed dependencies and refuses an existing destination. `BUILD_NODE` defaults
to the invoking executable; the recorded builds used Node 24.19.0. Tests and all
timing workers used Node 26.12.0. `CSV_JS_BUILD_ROOT` selects a fresh directory for
another pair of builds; pass it to both commands.

Run the isolated candidate's normal build/typecheck/test/package checks from its
package directory to repeat qualification. `npm run test:package` needs network
access for its five temporary clean consumers and permission to bind a local
protocol test server. It removes the temporary package archives afterward.

The runner uses the unchanged tracked `outputs/csv/compare.mjs` worker. It creates
the same seed-20261017 tiny/narrow/wide fixtures, rotates all five worker cases,
and runs five rounds sequentially. `BENCH_ROUNDS` changes rounds and `BENCH_OUT`
selects a new results directory. Each worker verifies output, warms twice and
times three batches with natural GC. Query paths are included as fallback
controls; the main comparison is the three table encoders. Time includes CSV/ZIP
delivery and completion to a counting Node writable, without HTTP or disk.

Whole-process peak RSS includes imports, database setup, verification, warmups and
timed requests. It is not incremental memory per export or a RAM limit. Plain
hashes must agree across all methods; table/manual ZIP hashes must agree, while
queries share another ZIP entry name and agree with each other. Timing workers
have no forced GC or profiling hooks. The configuration records fixture, Node,
worker, candidate patch and build hashes.

See [the report](../CSV-JS.md) and [raw results](../../../outputs/csv-js/comparison/summary.json).
