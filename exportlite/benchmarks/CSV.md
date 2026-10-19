# CSV exports

Measured October 18, 2026 on Apple M1 Pro, Node 26.12.0, better-sqlite3 13.0.3. CSV is available through native, Drizzle and experimental Turso APIs with `format: "csv"`. JSONL remains the default. No runtime dependency was added. `csv-parse` 7.0.3 and `csv-stringify` 6.9.0 are pinned development tools.

SQLite escapes cells and joins eligible table records into the existing 256-row batches. Custom queries and fallback tables stream records. The existing 64 KiB writer, Web/file/Node output, ZIP settings, ownership, cancellation and backpressure remain in use. Declared exports still execute one data statement without metadata preflights. CSV headers use output aliases and are not included in row counts.

## Comparison

Same seeded varied fixture generator and Node executable as the existing JSON comparisons: narrow = 50,000 records with short notes; wide = 15,000 records with approximately 1 KiB notes, variable lengths and occasional larger notes. Both have four columns, Unicode and NULLs. “Wide” here describes record size. The tiny 100-record fixture remains in the raw data.

Times include statement construction/preparation, execution, CSV formatting, UTF-8 delivery, ZIP when selected and destination completion. Imports and connection setup are outside timing, but are included in whole-process peak RSS. Each method uses three fresh workers, rotating order; each worker verifies a hash, warms up twice, then measures three request batches. Results are medians of worker medians, with natural GC. Memory is median process peak RSS across those workers, rather than a live-memory limit. No disk, HTTP, cloud or slow-consumer performance is claimed.

Manual JS iterates row objects, uses an explicit quoting encoder and the same 64 KiB buffering and callback/drain waits. The library baseline pipes row objects through `csv-stringify` and buffers encoded output to the same target. Both yield every 2,048 rows and use the same ZIP level 1, memLevel 9 and 256 KiB zlib buffer. Every plain CSV hash matches the independently parsed library reference. Table/manual/library ZIP hashes match; the query archive differs only because its entry is named `export.csv` rather than `data.csv` (four additional archive bytes).

| Fixture | Output | Method | Total ms | Median peak MiB | Highest peak MiB | Output bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| narrow | none | ExportLite table | 43.00 | 98.7 | 99.0 | 2,634,697 |
| narrow | none | ExportLite query | 62.27 | 79.4 | 79.5 | 2,634,697 |
| narrow | none | Manual JS streaming | 43.84 | 89.4 | 89.9 | 2,634,697 |
| narrow | none | csv-stringify streaming | 103.48 | 144.7 | 145.8 | 2,634,697 |
| narrow | zip | ExportLite table | 47.36 | 99.4 | 100.5 | 968,376 |
| narrow | zip | ExportLite query | 68.42 | 90.4 | 90.5 | 968,380 |
| narrow | zip | Manual JS streaming | 48.24 | 100.8 | 104.2 | 968,376 |
| narrow | zip | csv-stringify streaming | 106.39 | 156.7 | 158.9 | 968,376 |
| wide | none | ExportLite table | 38.30 | 178.7 | 186.6 | 14,619,815 |
| wide | none | ExportLite query | 62.56 | 118.0 | 118.5 | 14,619,815 |
| wide | none | Manual JS streaming | 47.15 | 139.2 | 140.0 | 14,619,815 |
| wide | none | csv-stringify streaming | 68.21 | 152.8 | 153.9 | 14,619,815 |
| wide | zip | ExportLite table | 103.08 | 173.5 | 177.7 | 3,999,471 |
| wide | zip | ExportLite query | 106.91 | 110.3 | 111.1 | 3,999,475 |
| wide | zip | Manual JS streaming | 105.97 | 123.3 | 123.8 | 3,999,471 |
| wide | zip | csv-stringify streaming | 109.00 | 141.4 | 141.5 | 3,999,471 |

Table batching is about even with optimized manual JS for narrow records and about 23% faster in throughput for wide uncompressed records (19% less elapsed time). It is about 2.4× the throughput of the library baseline on narrow uncompressed records, and about 1.8× on wide records. ZIP largely removes the manual-JS speed difference; compression dominates. The query fallback is slower than optimized manual JS here, because it performs SQLite escaping and transfers one formatted record at a time.

Memory is not universally lower than JS streaming. Wide table CSV uses about 179 MiB peak RSS plain and 174 MiB zipped, versus about 139/123 MiB for manual JS. The wide query path uses less memory (118/110 MiB), at the cost of slower uncompressed generation. Fixed row batches and buffering avoid collecting the full export, but record width, native buffer allocation and natural GC still affect process peaks. These measurements do not establish a hard RAM ceiling or long-lived memory trend.

## Small implementation choices

The binary CSV path uses a temporary two-byte ASCII prefix inside SQLite, removed with a buffer view before delivery. This preserves the existing UTF-16 declaration check even when the first text cell starts with a NUL byte. No extra data request or record parsing is needed. UTF-16 databases retain the existing driver-decoded text fallback. Query/fallback SQL has an OFFSET boundary that prevents flattening from evaluating computed values repeatedly while inspecting/escaping them. A query-plan assertion checks co-routine streaming without forcing materialization.

An exploratory text-only table path reduced wide ZIP peak RSS to about 134 MiB but increased uncompressed wide time from 39.04 to 64.33 ms (+65%) and increased its plain peak RSS. We kept the faster byte path. The final prefixed version retains comparable speed and exact output hashes. Compact evidence: [initial byte path](../../outputs/csv/native-original-summary.json), [text path](../../outputs/csv/text-path-summary.json). Neither experiment is a public option.

## Validation and reproduction

The complete suite has 405 passing tests. Added CSV cases cover all four native/Drizzle/Turso combinations, plain and independently decoded ZIP output/CRC, CSV parsing, empty/header-only results, batch boundaries, aliases, NULL/empty text, embedded quote/CR/LF/NUL, Unicode, exact 64-bit digits, declared boolean/JSON modes, BLOB failures, UTF-16, raw Drizzle bindings, computed-expression evaluation, backpressure, cancellation, cleanup and client reuse. Public type checks map CSV cells to strings while preserving the existing JSON contracts. Five isolated real-tarball consumers exercise ESM/CommonJS runtime and declarations with each optional peer combination. Turso coverage remains a local protocol test.

The paired JSON/ZIP regression matrix covers 144 fresh workers and 24 cases across native/Drizzle table/query APIs. All output hashes match the pre-CSV build. Bulk timing changes range from -3.2% to +7.8%; median peak RSS changes range from -4.0% to +1.6%. A tiny query ZIP case initially measured +12.9%; a five-pair focused recheck measured -7.6%, so the slowdown did not repeat. These short-duration fluctuations are not evidence of a speed improvement either. [Focused recheck](../../outputs/csv/json-recheck/summary.json).

Build first, then run with the recorded Node 26.12.0 executable from the repository root:

```sh
node outputs/csv/compare.mjs
EXPORTLITE_BEFORE="$PWD/outputs/csv/baseline/dist" \
BENCH_OUT="$PWD/outputs/csv/json-regression" \
node outputs/phase2/compare.mjs
```

The regression command requires the pre-CSV build from commit `a22c0105e49429b18ac4a3881f4fdfb38e253b08` at that baseline path. Build it separately with the pinned dependencies and the same runtime; no baseline build or database fixture is committed. The CSV runner regenerates seeded fixtures.

Raw evidence: [CSV workers](../../outputs/csv/all.json), [CSV summary](../../outputs/csv/summary.json), [runtime, fixture and build hashes](../../outputs/csv/configuration.json), [JSON regression](../../outputs/csv/json-regression/summary.json) and [regression configuration](../../outputs/csv/json-regression/configuration.json). The CSV benchmarks are additional evidence, not completion of all stage 4 release qualification.
