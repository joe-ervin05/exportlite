# ExportLite v0 — fixed batching benchmark

Measured October 17, 2026. These results use the simplified v0 API: table batches are fixed internally at 256 rows, custom queries stream individual records, and there are no public batch-sizing controls or SQL callbacks.

## One million small records, file destination

The nullable TEXT payload is 32 characters and includes Unicode, quotes and LF. Each record also has an integer primary key, short name and integer flag.

| Method | Median ms | Min–max ms | Peak RSS MiB | Sampled heap MiB | First record ms | Max timer delay ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ExportLite table (256 rows) | 1105.7 | 1096.7–1109.0 | 104.5 | 20.6 | 3.2 | 1.6 |
| ExportLite query (row streaming) | 1379.8 | 1373.5–1389.6 | 96.0 | 12.9 | 3.7 | 2.3 |
| JS object streaming | 1533.9 | 1498.9–1562.7 | 110.4 | 19.0 | 2.8 | 1.5 |
| SQLite full-array aggregation | 891.0 | 887.7–913.2 | 446.9 | 184.3 | 890.0 | 870.1 |

## 100,000 large records, file destination

The same schema uses a 1,024-character payload instead. Fixed batching limits row count, not output bytes or process memory.

| Method | Median ms | Min–max ms | Peak RSS MiB | Sampled heap MiB | First record ms | Max timer delay ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ExportLite table (256 rows) | 1134.0 | 1132.3–1152.6 | 132.7 | 39.7 | 5.8 | 4.4 |
| ExportLite query (row streaming) | 1184.7 | 1164.9–1188.2 | 96.4 | 12.5 | 3.0 | 1.4 |
| JS object streaming | 1264.8 | 1243.7–1287.8 | 111.5 | 20.9 | 2.2 | 3.8 |
| SQLite full-array aggregation | 1078.0 | 1069.2–1111.8 | 579.9 | 238.6 | 1077.1 | 1042.1 |

## Validation and interpretation

All four implementations passed an independent 257-row parsed JSON equivalence check before timing; large timed runs checked row counts. Table batching executes one recursive data statement using indexed rowid ranges, with a key scan followed by payload aggregation per batch. Queries use one streaming data statement. Schema/probe queries remain separate. Integration tests validate views, virtual tables, WITHOUT ROWID and shadowed-rowid fallbacks, but the timed fixtures are ordinary rowid tables.

The full-array baseline builds the entire result in SQLite before transferring it to JavaScript. Its first-record latency and peak memory therefore cover the whole JSON array. JS object streaming iterates driver row objects and JSON.stringify()s each one. These simple table scans have matching output order in the fixture; no general ordering guarantee is inferred for arbitrary aggregate SQL. Performance measurements use JSON arrays; JSONL has correctness coverage.

## Environment and method

- Apple M1 Pro; 10 logical CPUs; 32.0 GiB system RAM.
- darwin 25.4.0 arm64; Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4.
- Three measured runs and one separate warmup per case, each in a fresh process. Method order rotates. Warmups mostly prewarm OS caches, not the measured process's JIT.
- Fixture creation and process/driver startup are outside the timer. Planning and destination completion are included. Files use local temporary storage without fsync.
- Node paths use the same 64 KiB output target and yield after at least 2,048 rows. Batched output yields at batch boundaries.
- Tables show medians of individual run metrics, with duration ranges. RSS is the absolute process high-water mark, including startup; it is not the memory size of one batch. Heap sampling is a lower bound.
- First-record time is measured when completed sink callbacks cover the first record. Timer delay is the maximum lateness of a 1 ms interval, with a short settlement period after completion. Scheduling and filesystem caching add noise.
- These cases validate a small prototype on one machine; they do not establish a universal speed advantage, an absolute memory ceiling or relational performance.

Raw observations: [Small records](results/v0-narrow.json), [Large records](results/v0-wide.json). Reproduction commands are in the package README. Earlier experiments are preserved separately from this simplified working package.
