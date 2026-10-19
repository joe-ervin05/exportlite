# JS CSV encoding inside ExportLite

Follow-up: the [simpler JS encoder investigation](CSV-JS-FOLLOWUP.md) separates driver normalization from delivery overhead, measures exact native-value prototypes against the current SQLite/manual paths, and fixes raw JSONB rejection. The measurements below retain the earlier implementation and ZIP checksum settings.

The JS candidate reduces memory for wide exports, but does not replace SQLite batching without a speed tradeoff. Keep the current SQLite default. The candidate remains a reproducible benchmark experiment, with no new public option, dependency or runtime change in the normal package sources.

Measured October 19, 2026 on Apple M1 Pro, Node **26.12.0**, SQLite **3.53.4**, using the exact Node executable and fixture hashes from the previous CSV comparison. Registry checks found the current pinned versions: better-sqlite3 13.0.3, zip-stream 7.0.5, csv-stringify 6.9.0 and csv-parse 7.0.3. No dependency updates were needed.

## What was compared

- **ExportLite SQLite:** current commit `6cedfe09ff9853116906a62426cfccc237bac0a8`, including the previous wide-buffer copy fix. SQLite builds CSV records, joins eligible table records in 256-row batches and returns UTF-8 batch Buffers. This is one export statement.
- **ExportLite JS candidate:** same public API and delivery pipeline. SQLite returns each cell's storage kind and canonical scalar text; a small JS encoder quotes/escapes text, joins fields and emits records. It reads rows individually and uses the existing writer, ZIP compression, cancellation and cleanup.
- **Manual JS:** unchanged four-column, hand-written JS streaming baseline from the previous CSV measurements. It reads ordinary row objects, quotes fields and buffers writes. It is optimized for this fixture and does not implement all ExportLite validation and stream ownership behavior.

SQLite scalar normalization remains in the JS candidate to preserve exact signed 64-bit integers, REAL spelling, dynamic storage types, strict boolean/JSON conversions and BLOB rejection. Simply converting all driver values with JS `String()` would change the existing CSV contract. The manual baseline is equivalent on these fixtures, which use safe integers, text and NULL; it is not a replacement for those guarantees on arbitrary data.

The candidate moves CSV escaping and record joining to JS. It does not add a public encoder switch, a custom SQLite function or a second data query. Native and local Drizzle table/query APIs use it in the isolated candidate build. Turso continues using the existing SQLite implementation; this is not a remote performance benchmark.

## Method

Five rounds, 150 sequential fresh worker processes, 30 cases including query fallback controls. Each worker verifies output, warms up twice, then measures three batches with natural GC. Bulk batches contain two exports; tiny batches contain 50. Results are medians of five worker medians. Timing includes query preparation/planning, CSV generation, UTF-8 encoding, ZIP when enabled, writes and completion to a counting Node writable. Connection/import setup is excluded from time but included in process memory. No HTTP, disk, simulated latency, forced GC or profiling hooks are in these measurements.

**Memory is the median of five whole-process peak RSS readings**, including setup, verification, warmups and repeated exports. It is not incremental memory for one export, and is not a hard memory bound. All per-worker readings and maximum peaks are retained in the raw results.

The exact seed-20261017 fixtures are tiny: 100 repeated rows; narrow: 50,000 varied rows with roughly 32-character notes; wide: 15,000 varied rows with roughly 1 KiB notes and occasional longer notes. All fixture SHA-256 values match the previous comparison. Plain output sizes are 6,535 / 2,634,697 / 14,619,815 bytes; matching table ZIP sizes are 793 / 968,376 / 3,999,471 bytes. Every plain output hash matches all three encoders. Table ZIP bytes/hashes also match exactly; query ZIP hashes match between implementations, with another entry name.

### Batching

The production SQLite table path has a fixed **256 rows per SQL batch**. There is no adaptive controller. Queries and fallback tables yield one record at a time. Both the JS candidate and manual JS always read individual records and buffer their encoded output to roughly **64 KiB**. The writer uses the same target for SQLite batches, writing an already larger batch without splitting it. A wide SQL batch can therefore substantially exceed 64 KiB.

Both package builds retain the fixed writer, callback/drain waits and 2,048-row cooperative yields. ZIP settings remain level 1, memLevel 9 and a **256 KiB compression output chunk**; that last value is separate from the 256-row SQL batch and 64 KiB input flush target. Buffering is unchanged within each existing delivery implementation, without artificially forcing SQL batches and JS rows into identical allocation patterns.

## Table results

Each cell is **total milliseconds / median peak RSS MiB**; lower is better.

| Fixture | Output | ExportLite SQLite | ExportLite JS | Manual JS |
| --- | --- | ---: | ---: | ---: |
| Tiny | Plain | 0.252 / 69.4 | 0.299 / 71.9 | 0.188 / 65.5 |
| Tiny | ZIP | 0.617 / 105.0 | 0.703 / 97.7 | 0.482 / 100.0 |
| Narrow | Plain | 42.73 / 101.2 | 77.77 / 88.0 | 44.52 / 89.4 |
| Narrow | ZIP | 48.13 / 100.2 | 83.92 / 99.9 | 49.13 / 98.5 |
| Wide | Plain | 38.04 / 168.0 | 62.18 / 112.5 | 47.04 / 139.0 |
| Wide | ZIP | 105.18 / 149.5 | 107.48 / 119.6 | 108.33 / 123.0 |

For narrow exports, JS inside ExportLite takes **82% longer plain and 74% longer zipped**. Plain median peak RSS drops 13%; zipped memory is effectively unchanged. The candidate exposes each row and twice as many scalar slots (kind plus text), then escapes/joins it in JS. The manual baseline has simpler scalar handling and less validation. This comparison does not isolate those costs individually.

For wide exports, JS takes **63% longer plain**, with **33% lower** median peak RSS. With ZIP it is **2.2% slower**, with **20% lower** median peak RSS. Wide ZIP time is close to manual JS (107.48 versus 108.33 ms), and median peak RSS is also close (119.6 versus 123.0 MiB); those small differences do not establish a meaningful speed advantage. Highest observed wide peaks were 171.4 / 113.8 / 139.2 MiB plain and 151.4 / 123.0 / 123.4 MiB zipped for SQLite / package JS / manual JS.

The candidate avoids allocating large native CSV batch Buffers, which provides a plausible explanation for its lower wide memory. Its extra row-level JS/driver work explains why a memory improvement need not improve throughput. These are implementation observations, not a new allocation profile. Compression makes the wide total times converge. Tiny sub-millisecond differences are small in absolute terms, and its process memory includes 153 exports per worker.

## Query fallback controls

Each cell is again **milliseconds / median peak RSS MiB**. These paths were already row streaming in the SQLite implementation, so they do not test removal of native table batch Buffers.

| Fixture | Output | SQLite CSV rows | JS CSV rows |
| --- | --- | ---: | ---: |
| Tiny | Plain | 0.249 / 71.4 | 0.303 / 71.9 |
| Tiny | ZIP | 0.617 / 103.5 | 0.715 / 101.3 |
| Narrow | Plain | 62.75 / 79.5 | 78.39 / 88.1 |
| Narrow | ZIP | 70.31 / 90.4 | 85.20 / 99.7 |
| Wide | Plain | 64.22 / 117.2 | 60.80 / 113.6 |
| Wide | ZIP | 110.12 / 110.3 | 114.11 / 118.8 |

The JS candidate does not consistently improve fallbacks either. Narrow queries slow down; wide plain queries improve about 5%, but wide ZIP memory increases. These results do not justify an automatic encoder-selection policy or another public option for this initial package.

## Reliability and API validation

The candidate passes build, TypeScript, lint and **410 tests**, including a second complete test run from the isolated patch-built project. Its generated public declarations are byte-identical to the SQLite build. Five real packed consumers pass runtime and inferred type checks in ESM and CommonJS: no peers, native, Turso, Drizzle-native and Drizzle-Turso. The temporary tarball is removed by the check. No npm publication is performed.

Coverage includes independent CSV parsing, ZIP decoding/CRC and entry names, Unicode/NUL, empty/NULL cells, aliases, exact large integers and REAL formatting without driver safe-integer mode, UTF-16 declarations, BLOB/boolean errors, Drizzle JSON, single-query behavior, sustained backpressure, awaitable cancellation, caller writable ownership, database reuse and cleanup of owned partial files. The experiment changes six SQL-structure assertions to expect row streaming and measures paused production in rows instead of SQL batches; it preserves the sustained-stall and cancellation checks. Two additional tests cover numeric spellings for plain and ZIP table/query exports.

The normal package runtime was restored by reversing only the saved experiment patch. Its build/types/lint and **408 tests** pass. The candidate is locally qualified on macOS arm64 / Node 26.12.0; the package compatibility workflow covers the unchanged production code. Local Turso protocol checks do not qualify a live cloud deployment.

## Decision and reproduction

Keep SQLite as the default: it remains substantially faster for narrow exports and wide plain exports, with comparable wide ZIP throughput. The JS path offers a real wide-memory tradeoff, so the experiment is retained for future work, but it does not provide a general CSV improvement. No adaptive sizing, engine option or selection heuristic was added.

The [experiment instructions](csv-js/README.md) build the pinned SQLite source and JS patch into isolated ignored directories without altering normal package sources. Run `prepare.mjs` with the same build runtime and `run.mjs` with Node 26.12.0. Builds use Node 24.19.0; all tests and timing workers use Node 26.12.0. The unchanged tracked CSV worker is reused, so the manual control and buffering match the prior comparison.

Evidence: [summary](../../outputs/csv-js/comparison/summary.json), [all 150 workers](../../outputs/csv-js/comparison/all.json), [runtime/build/fixture/patch hashes](../../outputs/csv-js/comparison/configuration.json), [qualification](../../outputs/csv-js/qualification.json) and [candidate patch](csv-js/candidate.patch).
