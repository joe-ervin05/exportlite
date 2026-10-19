# Why the JS CSV prototype trails manual JS

**The old JS prototype did substantially more work than the manual control. A simpler exact-value prototype closes part of the gap, but does not consistently match manual JS or replace the current SQLite default.** The default encoder, batching, buffering, API and ZIP settings remain in place. A separate one-line CSV guard correction now rejects raw JSONB BLOBs, as the documented contract requires.

Measured October 19, 2026 on the same Apple M1 Pro, Node **26.12.0** executable, SQLite **3.53.4** and immutable CSV fixtures. Registry checks confirmed better-sqlite3 13.0.3, Drizzle 0.45.4 and zip-stream 7.0.5 remain current. Dependencies are unchanged.

## What made the old prototype expensive

The [original JS experiment](CSV-JS.md) returned **two SQLite results per cell**: its storage kind and canonical scalar text. Four fields therefore crossed the driver as eight values, even when the field was already ordinary text. SQLite evaluated `typeof()`/`CAST()` expressions, and the driver allocated the extra strings and array slots. Boolean/JSON normalization could also run repeatedly through those expressions.

The JS encoder then allocated a cell array for every record, escaped text, joined cells, yielded each record through a generator, and passed it through the generic delivery loop for framing, byte counting and writer checks. Manual JS used ordinary driver values and a four-field encoder prepared outside the loop. On these fixtures its integer values are safe JS numbers. That control does not preserve arbitrary 64-bit integer digits or SQLite REAL spelling, and its JSON parse/stringify operation is not equivalent for every possible JSON number.

These differences matter more than the existence of cancellation and cleanup code. The experiment retains those features while moving buffering ahead of the generic delivery loop.

## Separate driver-consumption diagnostic

Three rotating rounds of fresh workers consume prepared raw iterators and count rows/slots, without CSV encoding or writes. Each worker warms twice and measures five batches of three consumes. No per-record timing hooks or forced GC are used.

| Iterator result | Narrow ms | Wide ms |
| --- | ---: | ---: |
| Ordinary four-column SELECT | 25.01 | 21.98 |
| Same columns behind the evaluation fence | 27.93 | 24.15 |
| Old type/text pairs: eight values | 52.84 | 32.74 |
| Exact native values: four values | 40.22 | 27.78 |

The evaluation fence prevents SQLite from flattening a source whose computed fields must run once. The exact-value path also retains validation and numeric conversion. These diagnostics show substantial SQL/driver work before formatting starts; subtracting them from separate API medians would not assign exact percentages to individual functions. [All diagnostic workers and query plans](../../outputs/csv-js-simpler/ablation.json).

## Simplifications tested

| Candidate | Change | Outcome |
| --- | --- | --- |
| Joined records | Replace each temporary cell array/join with string assembly | Modest improvement in a one-round screen |
| Buffered JS | Keep type/text pairs, emit UTF-8 chunks near 64 KiB instead of yielding every record | Reduces delivery overhead, but leaves the expensive scalar projection |
| Tagged scalar text | One value per cell, with collision-safe numeric/text markers | Additional protocol rules without a general speed win; reject |
| Exact native values | Read INTEGERs as BigInt; return TEXT/NULL directly; format REALs in SQLite | Best general prototype in the five-round comparison below |
| Guarded native numbers | Use native Number only after SQLite proves the integer is safe; otherwise retain exact numeric text | Similar speed, often higher RSS; no general improvement over BigInt |
| Closure chain | Compose field encoders once without runtime code generation | Small/mixed one-round differences; no adoption |
| Raw values | Skip the numeric fidelity work | Diagnostic only: fails the output contract |

The exact-value prototype keeps one value per field. Real numbers use small internal BLOBs containing SQLite's numeric spelling; the encoder emits that ASCII text, accounting for UTF-16 databases. Raw source BLOBs remain errors unless explicitly selected through JSON mode or converted in SQL. Safe-integer mode is changed only on the fresh export statement, never on the caller's connection. The safe-Number variant checks its range **before** crossing the driver boundary.

Both substantial prototypes assemble complete records, buffer toward the existing output target, and yield at the 2,048-row boundary so cancellation can run. They use the current writer, Web-stream adapter, ZIP implementation, error handling and partial-file cleanup. They add no public option or second query. These are local native/Drizzle experiments; Turso keeps SQLite CSV generation.

## Five-round public API comparison

**250 sequential fresh workers**, five fixtures, five implementations and plain/ZIP output. Methods rotate each round. Each worker verifies bytes, warms twice, then times three batches of two exports: nine exports per worker. Time includes planning/preparation, formatting, UTF-8/ZIP, writes and completion to a counting Node writable. Imports/connection setup are excluded from time and included in whole-process peak RSS. Drizzle schemas/import formats match for the JSON fixture. No HTTP, disk, explicit GC, profiling, builds or tests run alongside these workers.

The old paired prototype is rebased onto current native CRC32 settings, so this comparison isolates its encoder work from the earlier ZIP checksum implementation. All paired plain bytes match the independent fixture reference; same-name ZIP bytes match across implementations. Manual ZIP uses the installed unmodified writer, while package builds use native CRC32. ZIP timings therefore compare complete pipelines, not just CSV encoder speed.

Each time is a median of five worker medians, in milliseconds:

| Fixture/output | SQLite default | Old paired JS | Exact native JS | Guarded-number JS | Manual JS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narrow/plain | 40.56 | 77.44 | 58.92 | 59.73 | 43.08 |
| Narrow/ZIP | 43.22 | 82.74 | 61.65 | 63.36 | 47.97 |
| Wide/plain | 37.68 | 58.68 | 52.66 | 55.15 | 46.29 |
| Wide/ZIP | 91.82 | 94.15 | 95.11 | 94.17 | 103.45 |
| Boolean/plain | 19.09 | 89.61 | 47.51 | 47.30 | 32.14 |
| Boolean/ZIP | 20.00 | 95.08 | 49.63 | 49.75 | 34.51 |
| JSON cells/plain | 45.43 | 149.29 | 129.65 | 131.24 | 173.66 |
| JSON cells/ZIP | 46.76 | 152.92 | 133.14 | 134.44 | 185.20 |
| 32 columns/plain | 91.36 | 177.65 | 150.72 | 156.09 | 124.01 |
| 32 columns/ZIP | 94.35 | 183.46 | 154.41 | 160.78 | 137.18 |

The exact native JS prototype saves about **24% narrow / 10% wide / 47% boolean / 13% JSON / 15% many-column** plain time versus the old JS prototype. It still takes about **37% / 14% / 48% / -25% / 22%** more time than manual JS respectively; the negative JSON value means it is faster there. The current SQLite default wins every plain fixture and remains substantially faster overall.

Median whole-process peak RSS, in MiB:

| Fixture/output | SQLite default | Old paired JS | Exact native JS | Guarded-number JS | Manual JS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narrow/plain | 100.8 | 87.8 | 78.3 | 89.3 | 88.5 |
| Narrow/ZIP | 93.7 | 99.4 | 91.0 | 98.1 | 102.8 |
| Wide/plain | 162.4 | 112.6 | 114.3 | 141.0 | 140.9 |
| Wide/ZIP | 140.4 | 114.3 | 116.7 | 122.7 | 119.5 |
| Boolean/plain | 85.1 | 82.7 | 77.0 | 84.4 | 85.3 |
| Boolean/ZIP | 82.8 | 90.9 | 83.8 | 91.0 | 92.1 |
| JSON cells/plain | 276.7 | 192.8 | 192.0 | 192.2 | 195.8 |
| JSON cells/ZIP | 245.7 | 198.9 | 198.9 | 198.3 | 203.2 |
| 32 columns/plain | 145.2 | 115.2 | 116.9 | 153.9 | 167.6 |
| 32 columns/ZIP | 120.9 | 110.4 | 109.0 | 138.5 | 150.5 |

These peaks include setup and repeated exports, not incremental RAM for one export or a hard cap. The simplified prototype does not lower every old-JS peak. Its memory advantage over SQLite remains a throughput tradeoff. REAL-heavy workloads, where its small numeric BLOBs are common, are not performance-qualified by this fixture matrix. Query exports receive functional qualification below, not new query throughput claims.

Some narrow ZIP observations have substantial wall-time variation: default SQLite ranges **42.8–59.9 ms**, manual **47.4–73.3 ms**. Unrelated background CPU use was observed on the host; no unrelated process was stopped. Rotating fresh workers, five rounds, CPU measurements and all ranges are retained. Small ZIP differences do not justify an encoder switch.

## Reliability finding and decision

The edge-case investigation found an existing defect: `json_quote(value)` accepts valid JSONB BLOBs. Used as a rejection guard, it could emit an object such as `{"a":1,"b":2}` directly into a CSV record without escaping its comma. Raw BLOBs are documented as unsupported. A deliberate failing JSON expression now rejects every raw BLOB; explicitly declared JSON-mode cells still canonicalize JSONB and escape it correctly.

The production change is confined to that cold BLOB branch in `planner/csv.ts`. Four regression tests cover six JSONB scalar/container types across native, Drizzle, local Turso and Drizzle-Turso, table/query and plain/ZIP: **96 rejected exports**, plus existing owned-file cleanup checks extended to JSONB. Client/connection reuse and the existing positive JSON-mode JSONB cases pass. The four new tests fail before the fix and pass after it.

**Keep SQLite CSV as the default.** The JS experiment can be made faster and retain the reliability features, but it still does not match manual JS consistently, and its speed is materially below the current package on most fixtures. Do not add an encoder selector, adaptive sizing, a raw-number shortcut or a new public option from these results.

## Qualification and evidence

Production and both substantial prototypes pass **473 tests**, including the new raw-JSONB coverage. Build, types and production lint pass. The first isolated prototype run lacked two example files; restoring those fixtures made all 469 original tests pass before the new regression tests were added. Those initial logs are retained rather than presented as runtime regressions.

A separate **168-export** comparison covers three database encodings, both caller safe-integer defaults, table/parameterized-query APIs, plain/ZIP, aliases, sparse keys, exact signed 64-bit extrema, REAL spellings/infinities, NULL/empty text, leading/embedded NUL, quotes/newlines and Unicode. All **144 preserving exports** match production bytes; all **24 unsafe raw exports** expose numeric differences. No global safe-integer setting is changed. The main public declarations remain unchanged.

Timing builds are preserved separately from the subsequent BLOB-guard correction. The qualified prototypes differ from their timed versions only in the raw-BLOB rejection branch and added regression tests. Neither prototype ships. The final production BLOB fix has its own five-round before/after supported-data recheck; results and hashes are archived below.

| Production BLOB fix recheck | Before ms | After ms |
| --- | ---: | ---: |
| Narrow/plain | 40.26 | 40.20 |
| Narrow/ZIP | 43.65 | 42.83 |
| Wide/plain | 36.69 | 37.17 |
| Wide/ZIP | 90.89 | 91.58 |

All supported-data CSV/ZIP bytes match. Median changes range from -1.9% to +1.3%, with overlapping worker ranges; no meaningful speed change is established. Median peak RSS changes by less than 2.1 MiB, without a memory-improvement claim.

Source baseline: `c2f7c513ed0958b24bf2897b6e1da1b730ca0d3a`. The original paired experiment comes from `6cedfe09ff9853116906a62426cfccc237bac0a8` plus its saved patch, with current formatting/ZIP code overlaid. The baseline used for the narrow BLOB regression is `62ef56d498e945a3cd720f79edad8097ac293b78`, whose source/package/build configuration is identical to `c2f7c51`.

Evidence: [comparison and ranges](../../outputs/csv-js-simpler/comparison/summary.json), [all 250 workers](../../outputs/csv-js-simpler/comparison/all.json), [Node/fixture/build hashes and protocol](../../outputs/csv-js-simpler/comparison/configuration.json), [driver diagnostic](../../outputs/csv-js-simpler/ablation.json), [scalar byte equivalence and caller-setting checks](../../outputs/csv-js-simpler/fidelity-qualified.json), [BLOB regression recheck](../../outputs/csv-js-simpler/blob-regression/summary.json), [qualification](../../outputs/csv-js-simpler/qualification.json). The three one-round screens are exploratory, not release comparisons: [loop/representation screen](../../outputs/csv-js-simpler/screen-1/summary.json), [exact-value screen](../../outputs/csv-js-simpler/screen-2/summary.json), [safe-number/closure screen](../../outputs/csv-js-simpler/screen-3/summary.json).

## Reproduction

Use a fresh checkout with pinned dependencies, Node 26.12.0 for workers and Node 24.19.0 for builds. Generated sources, builds and databases stay untracked. The scripts refuse existing source/result directories; the fixtures come from the maintained CSV runner and must be generated first. From the repository root:

```sh
node26 outputs/csv-js-simpler/prepare.mjs
node26 outputs/csv-js-simpler/configure.mjs
node26 outputs/csv-js-simpler/native-values.mjs
node26 outputs/csv-js-simpler/guarded-values.mjs
BUILD_NODE=/path/to/node24 CSV_JS_CANDIDATES=sqlite,pairs,native-values,guarded-values node26 outputs/csv-js-simpler/build.mjs
CSV_JS_FIXTURES=narrow,wide,boolean,json,many-columns CSV_JS_CASES=sqlite,pairs,native-values,guarded-values,manual EXPORTLITE_SQLITE_BUILD="$PWD/outputs/csv-js-simpler/base/exportlite/dist" BENCH_ROUNDS=5 BENCH_OUT=reproduction node26 outputs/csv-js-simpler/run.mjs
node26 outputs/csv-js-simpler/ablate.mjs
```

The [timed](../../outputs/csv-js-simpler/native-values-timed.patch) and [qualified](../../outputs/csv-js-simpler/native-values-qualified.patch) exact-value patches, and their [guarded-number counterparts](../../outputs/csv-js-simpler/guarded-values-qualified.patch), apply to the pinned `c2f7c51` tree using `git apply --unidiff-zero`. Qualified sources add the narrow BLOB correction and current tests. They are reviewable experiments, not a supported encoder API.
