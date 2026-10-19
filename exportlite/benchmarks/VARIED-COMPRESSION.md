# ExportLite — varied-data gzip benchmark

Measured October 17, 2026. These runs repeat the ExportLite versus JS object streaming comparison with no compression, gzip level 1 and default gzip, replacing the repeated note with seeded synthetic business records. Compression remains outside the core package; runtime source, API, compiled package and benchmark worker are unchanged.

## Data construction

The same four-column schema is retained: integer id, name, nullable note and integer active flag. Names include international characters and optional middle initials. Notes contain distinct seeded references, order/invoice amounts, dates, product descriptions, tracking URLs, synthetic email addresses, delivery instructions, quoted text and occasional newlines. Short notes are complete payment, invoice, order, return, delivery or follow-up messages; longer notes combine varied business/support clauses. Templates and categories still repeat, as they do in structured business records.

Seed: **20261017**, with deterministic generation verified by rebuilding the fixture twice and comparing all rows. Width 32 selects short complete messages, with naturally varying lengths. Width 1024 selects longer notes with ordinary character lengths from 0.5 to 1.5 times that target. For large notes, independently selected 1% of non-NULL records have a further 4–12 times length multiplier. These are character targets, not byte caps; actual UTF-8 distributions appear below. Every seventh note is NULL; 72% of active flags are true in expectation. All data generation and distribution/cardinality queries happen before timing.

## 1,000,000 varied records, nominal 32-character notes

Uncompressed JSON is **79.51 MiB**. There are 114,980 distinct names, 857,142 distinct notes among 857,143 non-NULL notes, and 142,857 NULL notes (14.3%).

Non-NULL note size in UTF-8 bytes: min 23, mean 30.0, median 29, p95 39, max 44. These describe the data only; ExportLite still uses fixed 256-row batches.

| Exporter | Compression | Total seconds | Min–max seconds | Output MiB | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| ExportLite | None | 0.60 | 0.58–0.78 | 79.51 | 93.7 |
| JS object streaming | None | 1.00 | 0.98–1.05 | 79.51 | 98.6 |
| ExportLite | Gzip level 1 | 0.78 | 0.77–0.81 | 20.37 | 97.7 |
| JS object streaming | Gzip level 1 | 1.14 | 1.13–1.17 | 20.37 | 98.5 |
| ExportLite | Default gzip | 1.46 | 1.45–1.48 | 17.44 | 96.3 |
| JS object streaming | Default gzip | 1.56 | 1.55–1.60 | 17.44 | 98.2 |

- ExportLite uses 40.0% less elapsed time without compression, 31.7% less with level 1, and 7.0% less with default gzip.
- For ExportLite, level 1 takes 29.7% more elapsed time than no compression. Default gzip takes 142.4% more elapsed time and 222.6% more process CPU time than no compression.
- Default gzip takes 86.9% more elapsed time than level 1 and produces 14.4% less output. Encoded sizes match between exporters for every mode.

Compared with the earlier repeated-note fixture, the percentage of original bytes remaining is:

| Mode | Earlier repeated text | Varied business records |
| --- | ---: | ---: |
| Gzip level 1 | 6.8% | 25.6% |
| Default gzip | 5.8% | 21.9% |

Raw observations, generator metadata, seed and sample records: [varied-compression-narrow.json](results/varied-compression-narrow.json).

## 100,000 varied records, nominal 1024-character notes

Uncompressed JSON is **96.25 MiB**. There are 27,738 distinct names, 85,715 distinct notes among 85,715 non-NULL notes, and 14,285 NULL notes (14.3%).

Non-NULL note size in UTF-8 bytes: min 512, mean 1105.5, median 1035, p95 1504, max 18555. These describe the data only; ExportLite still uses fixed 256-row batches.

| Exporter | Compression | Total seconds | Min–max seconds | Output MiB | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| ExportLite | None | 0.76 | 0.74–0.82 | 96.25 | 113.6 |
| JS object streaming | None | 0.83 | 0.82–0.85 | 96.25 | 119.5 |
| ExportLite | Gzip level 1 | 1.31 | 1.30–1.33 | 25.88 | 113.0 |
| JS object streaming | Gzip level 1 | 1.07 | 1.06–1.18 | 25.88 | 115.8 |
| ExportLite | Default gzip | 2.00 | 1.99–2.07 | 21.55 | 112.9 |
| JS object streaming | Default gzip | 1.69 | 1.68–1.71 | 21.55 | 114.9 |

- ExportLite uses 9.0% less elapsed time without compression, 22.0% more with level 1, and 18.7% more with default gzip.
- For ExportLite, level 1 takes 73.2% more elapsed time than no compression. Default gzip takes 165.4% more elapsed time and 200.2% more process CPU time than no compression.
- Default gzip takes 53.2% more elapsed time than level 1 and produces 16.7% less output. Encoded sizes match between exporters for every mode.

Compared with the earlier repeated-note fixture, the percentage of original bytes remaining is:

| Mode | Earlier repeated text | Varied business records |
| --- | ---: | ---: |
| Gzip level 1 | 1.3% | 26.9% |
| Default gzip | 0.8% | 22.4% |

Raw observations, generator metadata, seed and sample records: [varied-compression-wide.json](results/varied-compression-wide.json).

## Interpretation and limits

Use these measurements to assess the relative cost of exporting and compressing this synthetic business workload. Distinct values alone do not imply incompressible data: field names, language, templates and categories repeat. This is more varied than the previous single-payload fixture, but it is not a production sample or a universal compression ratio.

Total time includes export planning, serialization, output/compressor creation, compression finalization and file close. These stages overlap with backpressure. Differences between compressed and uncompressed elapsed time are whole-pipeline effects, not isolated compression timings. Process CPU time, sampled heap and individual observations are available in the raw data. Small differences should be assessed against the min–max ranges.

The varied fixtures have different actual byte volumes and length distributions from the earlier constant-width Unicode fixtures. Compare compression by the percentage of original bytes remaining; do not interpret raw time changes between the two reports as a controlled measure of data entropy alone. Downloads, client decompression, concurrent exports, cold storage and expensive joins/sorts are not timed.

## Method and validation

- 5 measured fresh-process runs plus 1 warmup for each of six exporter/compression combinations and each dataset. Combination positions rotate; workers run sequentially. Fixture creation, driver/process startup and correctness checks are excluded from timing.
- Apple M1 Pro; 10 logical CPUs; 32.0 GiB RAM; darwin 25.4.0 arm64; Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4; bundled zlib 1.3.2.1-motley-3246f1b. The latest driver version was checked before running; dependencies were not changed.
- Same ordered table scan and JSON fields for both exporters. ExportLite uses fixed 256-row SQLite JSON batches. JS object streaming iterates better-sqlite3 objects and uses JSON.stringify(). Both keep the same 64 KiB output target and yielding cadence as the prior comparison.
- Same benchmark worker, byte-counting Transform and file destination as before. Compression uses one continuous createGzip({ level: 1 }) or createGzip() stream, without per-batch resets or explicit flushes. Files are written to local temporary storage without fsync.
- Every combination first passed an independent 257-row parsed JSON comparison. Every warmup and timed output was checked after the worker finished: decompress when necessary, validate the gzip trailer, hash the entire decoded byte stream, compare raw byte counts and check encoded sizes against filesystem sizes. Verification is outside the timed process and does not inflate its reported memory.
- Peak RSS is the median of each process's absolute resident-memory high-water mark, including startup and native memory. It is not a per-batch memory allocation or a hard memory bound. Heap sampling is a lower bound. OS caches, scheduling and filesystem behavior affect timings.
- Earlier results are preserved in [the repeated-data report](COMPRESSION.md). Samples and measured note-size/cardinality statistics are included in each new raw JSON file.

## Reproduce

Build the package, then run:

```sh
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/varied-compression-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/varied-compression-wide.json
node benchmarks/varied-report.mjs
```
