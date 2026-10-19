# Development benchmark evidence

This directory preserves selected measurements, validation records and investigation sources from ExportLite's development. The reports in `exportlite/benchmarks/` explain the datasets, timing boundaries and limitations.

The published records retain their measured numeric values, output sizes and hashes. Local machine paths have been normalized as `<workspace>`, `<temporary>`, `<reference-workspace>`, `<development-runtime>` and `<node-26.12.0>`. Original source/build fingerprints describe the implementation at measurement time; publication path normalization and later changes do not create new benchmark results.

These one-off investigation runners are archival sources. They retain their original version, native-driver and fixture assumptions, including dependencies on saved implementations or temporary databases. Recreate/configure those inputs before adapting a runner to another machine. Use the fixture-generating runner in `exportlite/benchmarks/run.mjs` for new portable local measurements.

Compiled snapshots, local databases, dependency installations, generated downloads, raw profiler files, duplicate per-worker files and failed preliminary runs are excluded. Combined worker records, summaries, configurations and validations retain the evidence for the reported successful comparisons.

## Recorded investigations

- `performance-current/` and `performance-zip/`: full SQLite aggregation, ExportLite and JavaScript object streaming.
- `zip-memlevel-9/`: the later paired compression setting comparison.
- `plan-cache/`, `typed-columns/` and `declared-primary-key/`: metadata queries, caching and declared projections.
- `zip-direct/`, `zip-framed/`, `zip-batch-sizing/`, `zip-running-average/` and `zip-memory/`: buffering and batch-size experiments, including alternatives that were not adopted.
- `drizzle-adapter/` and `drizzle-adapter-benchmark/`: schema integration, output validation and measured adapter overhead.
- `turso-adapter/`, `turso-benchmark/`, `turso-session-reuse/` and `turso-concurrency/`: local HTTP protocol verification, simulated latency, session lifetime and concurrent exports.
- `phase2/`: paired delivery-refactor regression checks against the phase 1 build, including targeted timing and peak-memory rechecks.

The Turso comparisons use a local SQLite-backed protocol server. They do not establish live Turso Cloud compatibility or production scaling. Compression in Node reduces the download size after data reaches the application; it does not itself compress database-to-application traffic.
