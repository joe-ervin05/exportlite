# CSV performance checks

CSV is measured independently of JSON, through the public API, against a buffered
manual-JS encoder. Build the package and use a supported Node runtime:

```sh
pnpm build
pnpm bench:csv
```

The runner creates ten deterministic fixtures and starts sequential, isolated
workers for native/Drizzle table exports, query exports and manual JS, with plain
and ZIP output. Default results go under `outputs/csv-performance/` at the
repository root, outside the package payload. No databases or generated builds
belong in commits.

The fixtures cover 100-row responses, the existing varied narrow/wide data, the
same data with one boolean declaration, 90% NULL cells, quote/newline/NUL-heavy
text, three boolean fields, Drizzle JSON-mode fields and 32 selected columns.
The manual control chooses its cell encoders once, emits boolean CSV literals
directly and canonicalizes JSON in JS. All outputs must match independently
generated `csv-stringify` bytes and parse back to fixture values.

Use `BENCH_FIXTURES=tiny,narrow` or `BENCH_ROUNDS=1` for a functional smoke run.
Performance claims need the full five rounds. `CSV_BENCH_DIR` selects a new
fixture/results directory; `BENCH_OUT` selects another result destination.
`EXPORTLITE_AFTER` can select an isolated current build.

To include a previous build, prepare a **new** directory from the desired Git
revision. These commands run from the repository root:

```sh
BUILD_NODE=/path/to/node24 node exportlite/benchmarks/csv-performance/prepare-baseline.mjs
EXPORTLITE_BEFORE="$PWD/outputs/csv-performance/baseline/exportlite/dist" \
BEFORE_COMMIT=e601d1a61121c8a4eb27092f3869808b50aca412 \
node exportlite/benchmarks/csv-performance/run.mjs
```

The preparer defaults to the source before the CSV investigation. Its first
argument selects another ref and its second selects a fresh output directory.
It refuses to replace an existing directory, links the installed pinned
dependencies, builds the archived source and records its commit/build runtime.
`BUILD_NODE` defaults to the invoking executable. The recorded investigation
used Node 24.19.0 for builds and the same Node 26.12.0 binary for every timing
worker; use those versions when reproducing its numbers.

With a previous build, the runner rotates five cases: previous/current table,
previous/current query and manual JS. Without one, it rotates three cases.
Each worker verifies output, warms twice and times three batches, using natural
GC. Bulk batches contain two exports; tiny batches contain 50. Connection/import
setup is excluded from elapsed time but included in whole-process peak RSS.
Time includes planning, CSV generation, UTF-8/ZIP delivery and completion to a
counting Node writable, without disk or HTTP timing. Process CPU usage includes
compression threads.

Keep the 256-row SQL batches, 64 KiB writer target, 2,048-row yields and ZIP
level 1 / memLevel 9 / 256 KiB compression output chunks fixed when comparing
encoders. Record the Node executable, fixture and build hashes. Do not run CPU
profiles, forced GC, builds or another benchmark alongside a timing comparison.
Each ExportLite build uses its own ZIP/checksum implementation. The manual JS
control uses the installed, unmodified `zip-stream`; it is loaded only in manual
ZIP workers so package workers do not retain an extra unused ZIP implementation.

Whole-process RSS is not incremental memory for one export and is not a memory
limit. Check both median and highest process peaks. Compare table and query paths
separately: their streaming strategies differ. Tiny and compression-bound results
need repeated evidence before a small percentage is treated as a speed change.
An improvement should survive the diverse fixtures, the specialized manual
control, output checks and reliability tests. A faster median on one text width
does not justify an automatic encoder-selection policy.

The [investigation report](../CSV-PERFORMANCE.md) records the adopted changes,
rejected experiments, profiling limits and remaining work. Archived experiment
scripts and worker measurements are linked there; diagnostic timings are kept
separate from the matched comparison.
