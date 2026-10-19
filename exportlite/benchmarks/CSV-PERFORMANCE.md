# CSV performance investigation

There are worthwhile CSV improvements without changing the public API or streaming model. This change removes redundant boolean/JSON work and reduces common type-branch work in SQLite. With one boolean declaration on the existing business fixtures, table time falls **24% narrow / 10% wide** for plain output and **24% / 1%** with ZIP. Boolean-heavy and JSON-mode exports improve more. Ordinary untyped wide text is essentially unchanged.

Eligible table exports have lower median time than the manual controls across the nine bulk fixtures measured here. That is not a universal guarantee: tiny exports favor manual JS, simple query fallbacks still have a throughput gap, and wide ZIP differences are small enough to overlap ordinary run variation. The current package should not claim every CSV export is faster than well-written JS.

## What was measured

Measured October 19, 2026 on Apple M1 Pro, the same **Node 26.12.0 executable** and SQLite **3.53.4**. Builds used Node 24.19.0. The original tiny/narrow/wide SQLite file hashes match the previous CSV comparison. The typed variants reuse the exact narrow/wide files and change only the declaration of `active` to boolean. Additional fixtures stress NULLs, escaping, many columns and JSON/boolean modes.

The retained primary comparison contains **400 fresh workers / 80 cases** over eight fixtures, followed by **100 workers / 20 cases** for the realistic single-boolean declarations. A further **90-worker** paired recheck uses a more specialized manual control for boolean, JSON and 32-column data. Every comparison has five rounds, rotating method order, one output verification, two warmups and three timed batches. Bulk batches contain two exports, tiny batches 50. The original four-field manual path remains unrolled and buffered; it does not collect the export into one object/string.

Time includes planning/preparation, CSV generation, UTF-8/ZIP encoding, writes and completion to a counting Node writable. Imports/connection setup are excluded from time. There is no HTTP, network or filesystem delivery in these timings. Memory is median whole-process peak RSS across five workers, including setup, verification, warmups and repeated exports; maximum peaks are also retained. It is not incremental memory for one export or a RAM ceiling. CPU measurements include process threads.

Profiling and exploratory workers are separate from these full-delivery comparisons. No forced GC or profiling hooks run in the retained timing matrix. Do not use the exploratory RSS/timings as release comparisons: some prototypes retain verification text, instrument execution or omit reliability plumbing.

Registry checks found the pinned versions current: better-sqlite3 13.0.3, Drizzle 0.45.4, zip-stream 7.0.5, csv-stringify 6.9.0 and csv-parse 7.0.3. The ZIP chain is also current: compress-commons 7.0.1, crc32-stream 7.0.1 and crc-32 1.2.2. No dependency update is needed or included.

## Implemented change

Only the CSV SQL formatter and its selected-field call site change:

- **Booleans:** directly emit the existing quoted `"true"` / `"false"` CSV tokens, or the empty NULL cell. Previously each value went through strict boolean conversion, JSON parsing, storage-type inspection and CSV escaping. Invalid values retain the existing SQL error behavior.
- **JSON-mode cells:** test SQL NULL before calling `json(value)`, then escape the canonical text. Previously the canonicalization ran once to inspect its type and again to obtain its text. The converter guarantees text or NULL, so that repeated work is unnecessary.
- **Ordinary cells:** keep NULL first, then prioritize the declared numeric storage kind or text. Declarations affect branch order only. Runtime SQLite storage still determines quoting, exact integer/REAL spelling and BLOB rejection. A wrongly hinted type still uses the correct fallback.

There is no new public option, dependency, custom SQLite function, codec-selection policy, schema query or network request. Fixed 256-row table batches, 64 KiB writer target, 2,048-row yields and ZIP level 1 / memLevel 9 / 256 KiB output chunks remain unchanged. The archive/writer/cancellation implementation is untouched. Local and remote planners share the improved SQL; remote performance is not inferred from these local measurements.

## Matched table results

All times below are median total milliseconds. Positive saved percentages mean less time. The manual column is **plain / ZIP**; its three semantic/many-column cases are also checked against a specialized control below. Tiny changes are fractions of a millisecond, and sub-few-percent bulk changes should be treated cautiously.

| Fixture | Plain: previous → current | Time saved | ZIP: previous → current | Time saved | Manual JS: plain / ZIP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tiny: 100 rows | 0.247 → 0.251 | -1.7% | 0.635 → 0.618 | 2.7% | 0.190 / 0.477 |
| Narrow: 50k | 43.45 → 41.47 | 4.6% | 47.28 → 46.37 | 1.9% | 44.77 / 48.85 |
| Wide: 15k | 38.53 → 38.58 | -0.1% | 103.69 → 103.70 | -0.0% | 47.29 / 108.17 |
| Narrow + 1 boolean | 53.51 → 40.65 | 24.0% | 58.45 → 44.57 | 23.8% | 45.07 / 50.59 |
| Wide + 1 boolean | 42.28 → 38.08 | 9.9% | 105.67 → 104.25 | 1.3% | 49.55 / 108.11 |
| 90% NULL | 22.48 → 21.92 | 2.5% | 24.53 → 23.77 | 3.1% | 29.46 / 30.17 |
| Quote-heavy | 51.78 → 51.56 | 0.4% | 66.04 → 65.82 | 0.3% | 216.41 / 231.66 |
| 3 booleans | 53.15 → 19.39 | 63.5% | 55.53 → 22.47 | 59.5% | 38.25 / 41.01 |
| JSON cells (Drizzle) | 56.83 → 45.24 | 20.4% | 67.39 → 55.95 | 17.0% | 179.83 / 190.40 |
| 32 columns | 97.79 → 93.32 | 4.6% | 106.68 → 102.78 | 3.7% | 127.57 / 140.97 |

One boolean in the ordinary narrow fixture is enough to change the outcome: the previous table path took 53.51 ms versus the specialized manual control's 45.07 ms; the new table path takes 40.65 ms. With ZIP it moves from 58.45 to 44.57 ms, versus manual's 50.59 ms. This is a materially useful improvement on the same underlying business data.

The three-boolean fixture is deliberately a thin, boolean-heavy case. Its roughly 64% plain / 60% ZIP improvement should not be generalized to text-heavy exports. The single-boolean business fixtures show the more representative effect. Drizzle JSON-mode cells improve about 20% plain / 17% zipped in the primary comparison, with independent controls confirming the direction.

All before/after CSV and ZIP sizes and hashes match. Plain CSV independently matches csv-stringify and parses to fixture values. Table ZIP hashes also match the corresponding manual control; queries use `export.csv` and match before/after with that entry name. No gain comes from writing less data, changing quoting, compression level or omitting finalization.

## Stronger manual controls

The focused recheck selects cell encoders once, emits boolean literals directly and avoids per-cell metadata lookup. JSON is parsed/stringified in JS because those fixture cells require canonical JSON text. The control reads the driver directly, avoiding ORM query/mapping overhead. Its package before/after cases are interleaved in the same recheck.

| Fixture | Output | Previous package ms | Current package ms | Specialized manual ms |
| --- | --- | ---: | ---: | ---: |
| boolean | none | 52.99 | 19.99 | 33.38 |
| boolean | zip | 55.31 | 21.97 | 35.47 |
| json | none | 57.02 | 46.16 | 181.36 |
| json | zip | 67.33 | 57.81 | 192.81 |
| many-columns | none | 97.54 | 93.73 | 128.72 |
| many-columns | zip | 110.84 | 102.66 | 139.92 |

The boolean/JSON wins survive this stronger control. The 32-column control changes little, which is consistent with V8 already optimizing much of its simple metadata branching. A separate global-regex escaping control and tagged-cell query prototype were also screened; they did not establish a general improvement.

## Memory

Each cell below is **current package / manual**, in median whole-process peak RSS MiB. The earlier table's primary controls are used here so setup matches the raw comparison; the specialized recheck retains its own RSS evidence separately.

| Fixture | Plain RSS MiB | ZIP RSS MiB |
| --- | ---: | ---: |
| Tiny: 100 rows | 69.4 / 65.6 | 106.6 / 101.0 |
| Narrow: 50k | 100.2 / 89.4 | 100.0 / 102.8 |
| Wide: 15k | 163.8 / 146.0 | 145.5 / 122.3 |
| Narrow + 1 boolean | 100.4 / 100.4 | 100.3 / 103.6 |
| Wide + 1 boolean | 166.8 / 156.3 | 145.7 / 121.7 |
| 90% NULL | 76.9 / 83.1 | 84.2 / 90.2 |
| Quote-heavy | 170.4 / 167.6 | 156.8 / 127.7 |
| 3 booleans | 84.8 / 85.6 | 87.2 / 91.7 |
| JSON cells (Drizzle) | 238.2 / 157.1 | 252.1 / 110.5 |
| 32 columns | 141.7 / 169.5 | 128.2 / 151.1 |

The change does not introduce a new buffering pattern, and there is no consistent material memory shift. Before/after plain CSV destination chunk boundaries match exactly across the validation cases. Native table batches can still consume more process memory than manual row streaming, particularly for wide/JSON data. The JSON fixture loads Drizzle for package exports while its manual control reads the native driver directly, so their setup memory is also different; the entire RSS gap must not be attributed to the encoder.

Keep both latency and memory in performance decisions. These are natural-GC process peaks after repeated exports, not proof that a single export needs that much additional RAM. This work adds no hard byte cap; one very large record and fixed row batches can still require substantial memory.

## Query fallbacks remain a separate problem

Each cell is **current package / manual** total milliseconds. The basic controls shown here have the stronger semantic recheck above; for example the specialized boolean manual control is faster than the simple control used in this query matrix.

| Fixture | Plain query / manual ms | ZIP query / manual ms |
| --- | ---: | ---: |
| Tiny: 100 rows | 0.253 / 0.190 | 0.615 / 0.477 |
| Narrow: 50k | 61.53 / 44.77 | 67.29 / 48.85 |
| Wide: 15k | 62.31 / 47.29 | 107.31 / 108.17 |
| Narrow + 1 boolean | 60.67 / 45.07 | 66.43 / 50.59 |
| Wide + 1 boolean | 63.32 / 49.55 | 107.96 / 108.11 |
| 90% NULL | 40.38 / 29.46 | 44.96 / 30.17 |
| Quote-heavy | 95.91 / 216.41 | 115.80 / 231.66 |
| 3 booleans | 37.65 / 38.25 | 44.01 / 41.01 |
| JSON cells (Drizzle) | 73.64 / 179.83 | 85.72 / 190.40 |
| 32 columns | 115.35 / 127.57 | 127.74 / 140.97 |

Ordinary narrow and wide plain queries still lose to manual JS. They serialize and cross the driver boundary once per record, then do delivery/error/cancellation work. Eligible tables amortize those costs over 256 records. An arbitrary query cannot safely be converted to repeated keyset/offset queries: computed values may be nondeterministic, ordering/limits must survive, and the API promises one data statement.

The SQL-window experiment tried 8/32/64-row frames, both text and byte delivery, without adding a full-export materialization. It was slower: narrow serialization rose from about 63 to 99–191 ms and wide from 62 to 118–342 ms. Window bookkeeping, temporary rows and moving concatenation buffers outweighed fewer calls into JS. A packed-byte batch codec was similarly unsuitable: it roughly matched wide serialization but made narrow data more than twice as slow and quote-heavy data almost five times as slow. A tagged-cell JS query codec reduced one wide case but regressed narrow, NULL-heavy, JSON and many-column cases. These are not acceptable default changes.

A larger general query win likely needs a supported bulk-row driver interface or a native CSV formatting primitive, rather than another batch-size heuristic. A native extension/fork adds distribution and Turso compatibility costs and is not added to this JS package. Query exports retain their existing reliable streaming fallback.

## Native profile and rejected approaches

macOS native sampling resolves the SQLite functions inside the installed driver. Narrow records show substantial SQLite VM dispatch, comparison, allocation and copying work. Wide records show `replaceFunc` as the largest active formatter hotspot, plus copying and page reads. Sampling includes idle background threads; their wait counts are not CPU consumption. V8 profiling was attempted too, but too many native ticks were unaccounted for, so it was not used to assign precise function percentages.

More than 30 alternatives were screened, with body/output hashes checked:

| Approach | Observation | Decision |
| --- | --- | --- |
| Reorder common type branches | Small broad gain; preserve NULL fast path | Adopt conservatively |
| Direct boolean CSV tokens; one JSON canonicalization | Large, repeatable gains; same semantics | Adopt |
| `concat()` instead of quote concatenation; flatten cell construction | More function/branch work; no broad win | Reject |
| Quote detection, printf per cell/whole row | Additional scanning/format work; NUL needs a guarded fallback | Reject |
| Skip scalar casts, move CRLF into records, remove prefix copies | Little general benefit; some slower paths or reliability work still required | Keep current framing |
| Fixed batches 32–1,024 rows | Smaller batches add calls; larger batches give little speed and can raise memory | Keep 256 |
| TEXT batches instead of native byte batches | Less RSS in a screen; much slower wide encoding | Reject |
| One-pass composite key/data recursive batches | Extra aggregation/framing costs beat saved seeks | Reject |
| Raw typed cells, BigInt mode, JSON batches, JS SQLite callback | Extra calls/objects/serialization; no general win | Reject |
| Packed binary cell framing and JS byte escaping | Lower screen RSS; narrow and quote-heavy time regresses badly | Reject |
| Small SQL-window query batches | Large throughput regressions | Reject |
| Tagged-cell JS queries, regex escaping | Isolated wins; broad regressions | Reject |
| ZIP input queues 256 KiB–4 MiB | No consistent gain; narrow cases often slower | Keep 64 KiB |
| Native Node CRC instead of JS CRC | About 8% better wide ZIP in isolated screen; same archive bytes | Promising dependency-level follow-up |

The SQL-only screens are exploratory, with shorter sampling and no full delivery/reliability qualification. They are useful for rejecting clear regressions, not for choosing a default on a 1–2% difference. Full implementation decisions use the five-round API comparison and reliability checks.

## Highest-value next work

**1. Integrate native ZIP checksums through a supported dependency path.** The current ZIP dependency calculates CRC with JavaScript `crc-32.buf()`. Node already exposes native CRC on every supported runtime. The isolated preload replaces only that checksum operation; wide ZIP median moves from 103.65 to 95.30 ms (about 8%), narrow from 48.36 to 47.17 ms, with identical archive bytes. It is a three-round opportunity screen, not a shipped change. The package must not mutate a shared dependency module globally.

A small upstream feature-detected native implementation, retaining the dependency's Node 18 fallback, is preferable to a private-method hook. If that is unavailable, a separately qualified single-entry ZIP implementation is another option, but it needs independent ZIP64, CRC, cancellation and footer/error validation. A current alternative ZIP library, yazl 3.3.1, still uses a JavaScript checksum dependency, so a simple library swap does not resolve this by itself. Sources: [current checksum implementation](https://github.com/archiverjs/node-crc32-stream/blob/master/lib/deflate-crc32-stream.js), [Node CRC API](https://nodejs.org/api/zlib.html#zlibcrc32data-value), [yazl source](https://github.com/thejoshwolfe/yazl/blob/master/index.js).

**2. Treat generic query speed as driver/backend work.** Keep an independent query control in the benchmark. Favor a supported bounded bulk-fetch/CSV primitive if available rather than a custom serialized wire format, repeated statements, whole-export aggregation or unsafe type assumptions. The current supported driver does not expose such a bulk iterator, and the portable SQL alternatives measured here are slower. This is the main remaining gap in consistently beating manual JS across the entire API.

**3. Keep CSV performance checks first-class.** `pnpm bench:csv` now covers ten fixtures, table/query APIs, a specialized manual encoder, plain/ZIP time, CPU usage, whole-process peak memory and independent output validation. Run it for changes to the planner, delivery code, drivers or compression. Look for improvement across the relevant data families and both output modes, beyond run variation; preserve correctness and reasonable peak memory. Do not reintroduce adaptive/p95 sizing or automatic codec selection on the strength of one width or one median.

## Reliability and compatibility validation

Build, types, lint and **414 tests** pass on Node 26.12.0. Six new tests cover declaration/storage mismatches, exact signed 64-bit/REAL/Infinity spellings without driver safe integers, NULL versus empty text, JSONB and scalar JSON, large JSON integers and JSON failure cleanup. Existing cases retain independent CSV/ZIP parsing and CRC, Unicode/NUL, aliases/order/bindings, fixed boundaries, backpressure, awaitable cancellation, caller stream ownership, partial-file cleanup, UTF-16 declarations and local Turso session behavior.

There are **40 CSV/plain-ZIP equivalence cases** over ten fixtures and table/query APIs, with matching before/after bytes and hashes, plus **40 byte-identical generated JSON/JSONL plans**. Each declared export prepares one statement. Plain CSV destination write boundaries match. All 12 public declaration files remain byte-identical. Rebuilt final ESM files and the baseline preparer exactly reproduce the timed build hashes.

Five clean installed-package consumers pass runtime and inferred type checks in ESM/CommonJS: no peers, native, Turso, Drizzle-native and Drizzle-Turso. Package payload and optional-peer absence checks pass; temporary package archives are removed. No npm publication is performed. The >4 GiB ZIP64 exercise was not rerun because archive implementation/settings are unchanged. Live Turso Cloud and network performance remain unverified by this local investigation.

## Reproduction and evidence

The previous source is `e601d1a61121c8a4eb27092f3869808b50aca412`. The [implemented patch](../../outputs/csv-deep/implemented.patch) records the small runtime change and new tests. The [maintained runner instructions](csv-performance/README.md) prepare a new baseline from that Git tree and compare it with a built checkout. The runner defaults to the stronger manual encoder; the original recorded workers are archived separately.

Use the same Node 26.12.0 executable for the recorded measurements and the pinned dependencies. Main and targeted configurations record Node, fixture and build hashes. The later typed fixtures are the same underlying database files with one boolean declaration. The early eight-fixture matrix and later targeted/tuned controls are separate paired runs, not interchangeable samples from one combined median.

Evidence:

- [Primary 400-worker summary](../../outputs/csv-deep/comparison/summary.json), [all workers](../../outputs/csv-deep/comparison/all.json), [configuration](../../outputs/csv-deep/comparison/configuration.json).
- [Single-boolean 100-worker comparison](../../outputs/csv-deep/typed-comparison/summary.json) and [specialized-control 90-worker recheck](../../outputs/csv-deep/tuned-control/summary.json).
- [SQL screens](../../outputs/csv-deep/sql-screen.json), [hybrid/JSON/callback screens](../../outputs/csv-deep/hybrid-screen.json), [packed-byte screen](../../outputs/csv-deep/packed-screen.json), [window screen](../../outputs/csv-deep/window-screen.json) and [tagged-cell screen](../../outputs/csv-deep/prefix-screen/summary.json).
- [ZIP queue screen](../../outputs/csv-deep/zip-screen.json), [native CRC screen](../../outputs/csv-deep/crc-screen.json) and [native hotspots](../../outputs/csv-deep/native-hotspots.json).
- [Equivalence checks](../../outputs/csv-deep/equivalence.json), [qualification](../../outputs/csv-deep/qualification.json) and [installed-package check](../../outputs/csv-deep/package-check.txt).

Exploratory sources are archived under `outputs/csv-deep/`; builds, databases and raw V8 logs are not committed. The CRC preload and driver wrappers are experiments only and are not imported by the package.
