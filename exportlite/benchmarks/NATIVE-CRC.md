# Native CRC32 for streaming ZIP

October 19, 2026. The ZIP checksum now uses Node's native `zlib.crc32` rather than the JavaScript loop in `crc-32`. The public API, SQLite plans, 256-row batches, writer buffers, compression settings, backpressure and cancellation behavior are unchanged. This applies to JSON, JSONL and CSV through all three adapters.

## Implementation

The current ZIP dependencies have no public checksum hook. ExportLite bundles the existing, pinned `zip-stream` implementation and its dependencies, resolving their `crc-32` imports to an internal adapter implementing the `buf` operation they use. It accepts the upstream stream's initial four-byte seed and subsequent numeric seeds, preserving unsigned seed bits and the original signed return convention. There is no runtime module mutation, private-method override or new ZIP implementation.

The ZIP bundle remains a lazy import. `zip-stream` moves to development dependencies; installed consumers need no runtime ZIP/checksum dependencies. The bundle adds about 218 KB of JavaScript per module format plus source maps to ExportLite's payload, replacing the separate dependency installation. Third-party licenses ship in `THIRD_PARTY_NOTICES`, and a build allowlist catches unexpected bundled dependencies. Native CRC is available on every supported Node version. Sources: [Node CRC32 API](https://nodejs.org/api/zlib.html#zlibcrc32data-value), [upstream checksum stream](https://github.com/archiverjs/node-crc32-stream/blob/master/lib/deflate-crc32-stream.js), [supported bundler dependency options](https://tsdown.dev/options/dependencies).

Registry versions were checked before implementation: zip-stream 7.0.5, compress-commons 7.0.1, crc32-stream 7.0.1, crc-32 1.2.2 and tsdown 0.23.1 remain current. The existing resolved dependency graph is unchanged; no transitive major upgrades were included. Exact checks, including the newer incompatible major of event-target-shim, are in [versions.json](../../outputs/native-crc/versions.json).

## Matched CSV comparison

The baseline is `fcca5563d82ab7b6c607779ef59db360f7bba307`. The same Apple M1 Pro, Node **26.12.0** executable and ten fixtures from the [CSV investigation](CSV-PERFORMANCE.md) were used. The Node SHA-256 is `12ccc7c7d8b9b33ac0740fc7c2590d2aba14ccfa0a40f3d3f7a6c4c60c87f07c`.

Five rounds rotate previous/current table, previous/current query and specialized manual JS through plain and ZIP output: **500 sequential fresh workers**. Each verifies output, warms twice and times three batches with natural GC. Bulk batches contain two exports; tiny batches contain 50. Time includes planning, CSV generation, UTF-8/ZIP delivery and completion to a counting Node writable. Imports and connection setup are excluded from time but included in whole-process peak RSS. No HTTP/network or disk-delivery performance is measured. No profiles, builds or other benchmarks ran alongside the timing workers.

ZIP stays at level 1, memLevel 9 and 256 KiB compression output chunks, with the existing 64 KiB input writer. Every before/after archive hash and size matches. Plain CSV also matches independent `csv-stringify` output. The manual control uses the installed, unmodified ZIP library; package workers load only their own ZIP implementation. This avoids counting an unused second ZIP implementation in current workers.

Median table ZIP results:

| Fixture | Before ms | Native ms | Time reduction | Before / native median peak RSS MiB | ZIP bytes, unchanged |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tiny, 100 rows | 0.725 | 0.677 | 7% | 100.5 / 97.8 | 793 |
| Narrow | 47.13 | 44.45 | 6% | 100.8 / 92.6 | 968,376 |
| Wide | 106.17 | 94.18 | 11% | 147.3 / 139.6 | 3,999,471 |
| Narrow, one boolean | 46.46 | 43.30 | 7% | 100.8 / 92.8 | 986,927 |
| Wide, one boolean | 112.01 | 101.82 | 9% | 147.3 / 141.3 | 4,006,543 |
| 90% NULL cells | 24.95 | 24.26 | 3% | 83.4 / 77.3 | 146,748 |
| Quote/newline/NUL-heavy | 69.81 | 54.47 | 22% | 159.5 / 150.1 | 251,392 |
| Three boolean fields | 22.58 | 21.62 | 4% | 87.2 / 82.5 | 181,354 |
| Drizzle JSON-mode fields | 57.29 | 49.96 | 13% | 244.4 / 241.8 | 284,084 |
| 32 columns | 104.69 | 96.85 | 7% | 124.3 / 116.5 | 1,476,634 |

Query ZIP medians improve too: narrow **69.77 → 66.98 ms**, wide **108.88 → 100.91 ms**, quote-heavy **115.32 → 103.50 ms** and JSON-mode **88.46 → 79.14 ms**. This does not remove the separate per-row query formatting cost. Plain output does not execute the ZIP bundle and has no intended speed change; full plain/control results and timing ranges remain in the raw summary.

Memory is the median of five whole-process peaks, including setup, warmups and repeated exports, rather than incremental memory for one export. It is not a cap or a universal reduction: the highest wide-table peak was **151.3 → 155.5 MiB**, despite its lower median, and wide-query median peak was **109.8 → 112.2 MiB**. Small timing differences, especially the sub-millisecond tiny case, should not be treated as guaranteed improvements.

## Isolating checksum work from bundling

A second five-round comparison uses 60 fresh workers for four fixtures and three builds: the previous external library, the bundled library with its original JS checksum, and the shipped native bundle. Only the checksum import changes between the latter two. All archive hashes match.

| Fixture | Previous ms | Bundled JS CRC ms | Native CRC ms | Native reduction versus bundled JS |
| --- | ---: | ---: | ---: | ---: |
| Tiny | 0.654 | 0.645 | 0.631 | 2% |
| Narrow | 46.78 | 46.19 | 44.16 | 4% |
| Wide | 105.68 | 105.15 | 94.31 | 10% |
| Quote-heavy | 65.43 | 64.77 | 54.42 | 16% |

The large-record speed gain survives this control. Bundling and the checksum change both affect observed process memory; it would be incorrect to attribute the entire memory reduction to native CRC alone. The smaller quote-heavy gain in this separate run also illustrates ordinary timing variation. Neither comparison establishes JSON/JSONL timing improvements; those formats were checked for unchanged bytes and reliability.

## Validation

- Build, typecheck, lint and **469 tests** pass on Node 26.12.0. The streaming ZIP suite runs against built ESM and CommonJS, including backpressure, cancellation, output ownership, footer errors, SQLite failures and partial-file cleanup. Source-only initialization/finalization fault injection remains separate.
- IEEE CRC32 vectors, incremental chunk/seed boundaries, empty input and absence of mutation to another ZIP consumer are tested. All three export formats also match the original ZIP writer on Unicode, NULs and a large incompressible record spanning writes.
- **120 before/after cases** cover ten fixtures, table/query, JSON/JSONL/CSV and plain/ZIP. Export bytes and SQL match; every declared export prepares one statement. Plain destination chunk boundaries match. ZIP entries independently decode to the matching plain hash and size, with CRC validation. All **12 public declaration files** are byte-identical.
- Five fresh installed consumers pass ESM/CJS runtime and inferred-type checks: bare, native, Turso, Drizzle/native and Drizzle/Turso. No external ZIP/checksum packages are installed. Package checks verify notices, the bundled native adapter and absence of JS CRC source. Turso checks remain local protocol verification.
- An actual **4,296,065,036-byte** entry was streamed and independently decoded with matching CRC and ZIP64 sizes. See the [updated ZIP64 result](results/zip64-validation.json). Final ESM build hashes match the timed candidate.

## Reproduction and evidence

Use Node 26.12.0 for timing and Node 24.19.0 for builds. From the repository root, prepare a fresh baseline directory, then run the maintained benchmark:

```sh
BUILD_NODE=/path/to/node24 /path/to/node26 exportlite/benchmarks/csv-performance/prepare-baseline.mjs fcca5563d82ab7b6c607779ef59db360f7bba307 outputs/native-crc/baseline
CSV_BENCH_DIR="$PWD/outputs/csv-deep" \
BENCH_OUT="$PWD/outputs/native-crc/comparison" \
EXPORTLITE_BEFORE="$PWD/outputs/native-crc/baseline/exportlite/dist" \
BEFORE_COMMIT=fcca5563d82ab7b6c607779ef59db360f7bba307 \
/path/to/node26 exportlite/benchmarks/csv-performance/run.mjs
```

Build the current package first. The separate bundle control can be reproduced with `/path/to/node24 outputs/native-crc/build-control.mjs` followed by `/path/to/node26 outputs/native-crc/control.mjs`; the build refuses to overwrite an existing control directory. Run `outputs/native-crc/validate.mjs` for the all-format equivalence check after fixtures exist.

Raw evidence: [500-worker configuration](../../outputs/native-crc/comparison/configuration.json), [all workers](../../outputs/native-crc/comparison/all.json), [summary](../../outputs/native-crc/comparison/summary.json); [60-worker control configuration](../../outputs/native-crc/control/configuration.json), [control workers](../../outputs/native-crc/control/all.json), [control summary](../../outputs/native-crc/control/summary.json); [all-format equivalence and declarations](../../outputs/native-crc/equivalence.json), [test output](../../outputs/native-crc/tests.txt), [installed-consumer output](../../outputs/native-crc/package-check.txt). Archived control/validation scripts are alongside these files; generated databases and builds are not committed.
