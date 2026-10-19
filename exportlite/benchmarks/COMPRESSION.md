# ExportLite — streaming gzip benchmark

Measured October 17, 2026. Compare the current fixed-256 table API with JS object streaming, using no compression, gzip level 1 and default gzip. Compression lives entirely in the benchmark harness; the library source, API and compiled package are unchanged.

## 1,000,000 records, 32-character payload

Uncompressed JSON: **96.35 MiB**. Each row has an integer id, short name, nullable TEXT note and integer flag. The note repeats the same Unicode/quote/newline payload across rows, with NULL every seventh row.

| Exporter | Compression | Total seconds | Min–max seconds | Output MiB | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| ExportLite | None | 1.08 | 1.05–1.47 | 96.35 | 110.5 |
| JS object streaming | None | 1.48 | 1.46–1.57 | 96.35 | 113.5 |
| ExportLite | Gzip level 1 | 1.10 | 1.08–1.49 | 6.60 | 107.3 |
| JS object streaming | Gzip level 1 | 1.50 | 1.50–1.51 | 6.60 | 114.9 |
| ExportLite | Default gzip | 1.15 | 1.11–1.33 | 5.56 | 109.0 |
| JS object streaming | Default gzip | 1.55 | 1.55–1.64 | 5.56 | 115.2 |

- ExportLite's elapsed time is 26.8% lower without compression, 26.9% lower with level 1, and 26.3% lower with default gzip than JS object streaming.
- Level 1 removes 93.2% of the original bytes; default gzip removes 94.2%. Encoded sizes match exactly between the two exporters for each mode.
- For ExportLite, default gzip takes 4.4% longer than level 1 and produces 15.7% fewer bytes. These are whole-pipeline measurements, not isolated compressor timings.

Raw runs: [compression-narrow.json](results/compression-narrow.json).

## 100,000 records, 1024-character payload

Uncompressed JSON: **135.59 MiB**. Each row has an integer id, short name, nullable TEXT note and integer flag. The note repeats the same Unicode/quote/newline payload across rows, with NULL every seventh row.

| Exporter | Compression | Total seconds | Min–max seconds | Output MiB | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| ExportLite | None | 1.18 | 1.15–1.26 | 135.59 | 133.6 |
| JS object streaming | None | 1.23 | 1.20–1.32 | 135.59 | 115.2 |
| ExportLite | Gzip level 1 | 1.15 | 1.12–1.27 | 1.72 | 132.1 |
| JS object streaming | Gzip level 1 | 1.22 | 1.19–1.41 | 1.72 | 115.1 |
| ExportLite | Default gzip | 1.17 | 1.16–1.60 | 1.11 | 132.3 |
| JS object streaming | Default gzip | 1.29 | 1.20–1.65 | 1.11 | 113.7 |

- ExportLite's elapsed time is 4.6% lower without compression, 5.8% lower with level 1, and 9.1% lower with default gzip than JS object streaming.
- Level 1 removes 98.7% of the original bytes; default gzip removes 99.2%. Encoded sizes match exactly between the two exporters for each mode.
- For ExportLite, default gzip takes 1.9% longer than level 1 and produces 35.1% fewer bytes. These are whole-pipeline measurements, not isolated compressor timings.

Raw runs: [compression-wide.json](results/compression-wide.json).

## What the measurements establish

On these fixtures, compression did not become the dominant elapsed-time cost. Default gzip changed ExportLite's median wall time by 5.8% for small records and -0.4% for large records, while increasing total process CPU time by 39.8% and 28.3%, respectively. Compression work can overlap JSON generation and sharply reduces file I/O. The small apparent speedup with compression in the large-record case is within the run-to-run variability; it does not mean record serialization became faster.

Gzip had little effect on peak process memory within either exporter. ExportLite remained faster in every measured combination, while JS object streaming used less peak RSS for the large-record fixture. Default gzip produced smaller files than level 1 with only a small wall-time difference on this machine; the raw CPU measurements show that this extra compression work is not free.

Total time covers export planning, record serialization, UTF-8 conversion, the optional compressor, final compressed output and file close. The stages stream together with backpressure; their work can overlap. Subtracting the uncompressed time does not isolate compressor cost. CPU time and sampled heap are retained in the raw results.

These local-file results show the time/size/memory tradeoff, not actual download latency or a universal compression ratio. Both fixtures have strongly repetitive note content, so byte savings are optimistic for varied text, identifiers, encoded binary or already-compressed data. Network speed, client decompression, concurrent exports, cold storage and expensive query plans were not benchmarked. A slower stage downstream can hide the benefit of a faster exporter.

## Method and verification

- 5 measured runs plus 1 separate warmup per exporter/compression/case, each in a fresh process. The six combinations rotate positions across runs and are executed sequentially, without competing benchmark workers.
- Apple M1 Pro; 10 logical CPUs; 32.0 GiB RAM; darwin 25.4.0 arm64.
- Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4; bundled zlib 1.3.2.1-motley-3246f1b. The registry's latest better-sqlite3 version was checked before running and remains 13.0.3. No dependency was added or upgraded.
- Same database, row order, JSON fields, 64 KiB exporter output target and at-least-2,048-row yielding cadence for both exporters. ExportLite constructs JSON in SQLite in 256-row batches; JS object streaming uses better-sqlite3 row objects and JSON.stringify().
- Both write through the same byte-counting Transform and destination. Compression is one continuous Node createGzip({ level: 1 }) or createGzip() stream with otherwise-default settings. There is no per-batch reset or explicit flush.
- Every exporter/compression combination first passed a 257-row independent decoded JSON comparison. Every warmup and measured file was then streamed through gunzip if necessary and SHA-256 outside the timed worker. All decoded hashes and raw byte counts matched; encoded byte counts matched filesystem sizes. Compressed files therefore include validated final trailers.
- Fixture generation, connection/process startup and verification are outside the timer. Compression/output stream creation, finalization and file close are included. Local temporary files are written without fsync; OS caching affects results. Warmup mostly prewarms OS caches, not the measured process's JIT.
- Peak RSS is the median of each fresh process's absolute resident-memory high-water mark, including startup, native SQLite/zlib memory and buffers. It is not a per-batch allocation or a memory ceiling. Heap is sampled separately and is a lower bound. Timer sampling and byte counting add the same instrumentation to both paths.
- The uncompressed cases are fresh measurements through this common pipeline and should be compared within this report. The earlier fixed-batch report used a simpler destination harness.

## Reproduce

Build the package, then run:

```sh
node benchmarks/run.mjs --rows=1000000 --width=32 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/compression-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/compression-wide.json
node benchmarks/compression-report.mjs
```
