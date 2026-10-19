# Actual streaming ZIP exports

These runs compare the public `exportTable(..., { zip: true })` option with a JS object iterator plus `JSON.stringify()` and an equivalent streaming ZIP writer. Uncompressed exports provide a reference. ZIP contains one `data.json` entry; both implementations use zip-stream 7.0.5, DEFLATE level 1, a 256 KiB zlib output buffer, ZIP64, and the same fixed timestamp. The package retains its internal 256-row SQLite JSON batches.

For the smaller records, ExportLite took 0.682 s versus 1.074 s for JS object streaming (36.5% less time). Both ZIP files were 20.37 MiB. ExportLite's median peak RSS was 104.8 MiB versus 109.3 MiB.

For the larger records, ExportLite took 0.895 s versus 0.947 s for JS object streaming (5.5% less time). Both ZIP files were 25.88 MiB. ExportLite's median peak RSS was 123.6 MiB versus 123.5 MiB.

## Measurements

Median of five measured fresh-process runs after one warmup process per case. Cases rotate order and run sequentially. Total time includes planning, serialization, compression, CRC-32, archive finalization, all destination callbacks and local file close. Fixture creation, process/driver startup and independent validation are outside timing. File writes do not use fsync. OS caches affect the results.

| Dataset | Exporter | Output | Total seconds (min–max) | File MiB | Peak RSS MiB | Sampled heap MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1m smaller records | ExportLite | JSON | 0.590 (0.576–0.606) | 79.51 | 103.1 | 14.6 |
| 1m smaller records | JS objects | JSON | 0.982 (0.977–1.034) | 79.51 | 102.0 | 13.9 |
| 1m smaller records | ExportLite | ZIP | 0.682 (0.674–0.735) | 20.37 | 104.8 | 15.1 |
| 1m smaller records | JS objects | ZIP | 1.074 (1.072–1.094) | 20.37 | 109.3 | 13.9 |
| 100k larger records | ExportLite | JSON | 0.760 (0.733–0.772) | 96.25 | 129.0 | 34.5 |
| 100k larger records | JS objects | JSON | 0.811 (0.788–0.856) | 96.25 | 121.8 | 23.7 |
| 100k larger records | ExportLite | ZIP | 0.895 (0.891–0.904) | 25.88 | 123.6 | 29.5 |
| 100k larger records | JS objects | ZIP | 0.947 (0.908–0.966) | 25.88 | 123.5 | 24.4 |

Peak RSS is each fresh process's absolute high-water memory, including startup, database cache, strings and native compression buffers. The table reports the median of those high-water values. Sampled JS heap is a lower bound and excludes native memory. Both exporters load the same benchmark dependencies. Streaming avoids retaining the complete export; 256 rows and the compression buffer are not global RAM limits.

## Data and verification

Both datasets use the same seeded varied-data generator as the earlier compression investigation: international names, distinct references, dates, amounts, NULLs and support notes. Seed: 20261017. They remain synthetic business data with recurring categories/templates, not a production corpus or random binary data.

| Rows | Raw JSON MiB | ZIP reduction | Non-null note mean / p95 / max (UTF-8 bytes) | Distinct non-null notes |
| ---: | ---: | ---: | --- | ---: |
| 1,000,000 | 79.51 | 74.4% | 30.0 / 39 / 44 | 857,142 |
| 100,000 | 96.25 | 73.1% | 1105.5 / 1504 / 18555 | 85,715 |

Before timing, all four cases matched a parsed 257-row fixture. Every warmup and measured ZIP was independently decoded with yauzl, its full CRC-32 and uncompressed size checked, and its decoded SHA-256 compared with the uncompressed exports. Actual encoded file sizes matched the measured byte counts. The public option's `bytesWritten` was also checked against the counted destination bytes. For the package ZIP path, raw JSON byte count is computed by an untimed fixture scan; no measuring transform is inserted into its internal JSON stream.

The separate large-entry check streamed **4,296,065,036 decoded bytes** into a 17.92 MiB ZIP, then read the entire entry through yauzl with matching CRC-32 and sizes. Its central directory requires ZIP version 4.5. Combined export-and-validation peak RSS was 250.6 MiB. This deliberately compressible fixture tests the 4 GiB entry boundary; it is not evidence of typical compression ratios. A compressed archive itself larger than 4 GiB and every desktop extractor have not been tested.

The package tests cover JSON/JSONL boundaries, empty entries, query/table fallbacks, parameter binding, exact integer literals, backpressure, cancellation, stream ownership, write/close/finalization/footer failures, cleanup and WAL snapshots. No extra export query or adaptive sizing was added.

## Interpretation and limits

ZIP is a convenience around the existing exporter. Compression and ZIP checksums add work to both methods, so serialization savings do not translate directly into the same total-time advantage. The ZIP writer's CRC-32 calculation runs in JavaScript; native DEFLATE compression runs asynchronously. A faster uncompressed export can still finish near the JS baseline once compression dominates. These measurements apply to the tested machine, schema, data and settings.

The package's tuned compression settings are fixed internally. Level 1 favors speed over the smaller files potentially available at higher levels. The 256 KiB setting is the compressor's output buffer; it is separate from the exporter’s UTF-8 flush target. No per-batch archive, compressor reset or flush is used. JS object streaming receives the same tuning.

These are local file exports. Network transfer, concurrent exports, slow clients, client decompression and server CPU contention are not timed. Slower downloads can make the smaller ZIP more useful even when local export time increases. Queries/views and other streaming fallbacks are tested for correctness but are outside these timing tables.

Environment: Apple M1 Pro; darwin arm64; Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4; zlib 1.3.2.1-motley-3246f1b. Dependency versions were checked October 17, 2026. Cross-version CI has not been run.

## Reproduce

Build first, then run sequentially:

```sh
pnpm build
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,zip --destinations=file --out=benchmarks/results/zip-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,zip --destinations=file --out=benchmarks/results/zip-wide.json
node benchmarks/validate-zip64.mjs
node benchmarks/zip-report.mjs
```

Raw runs: [smaller records](results/zip-narrow.json), [larger records](results/zip-wide.json), [actual ZIP64 entry validation](results/zip64-validation.json).
