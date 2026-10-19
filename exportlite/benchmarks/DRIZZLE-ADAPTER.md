# Drizzle adapter: total time and peak memory

Measured October 18, 2026. Current public ESM package entries, the original varied fixture files, exact Node **26.12.0**, better-sqlite3 **13.0.3**, SQLite **3.53.4**, Drizzle ORM **0.45.4**, Apple M1 Pro / 32 GiB. Package versions were checked against the [Drizzle registry](https://www.npmjs.com/package/drizzle-orm?activeTab=versions) and [better-sqlite3 registry](https://www.npmjs.com/package/better-sqlite3?activeTab=versions); the existing pinned versions were retained.

This run measures uncompressed JSON generation through complete UTF-8 byte output. Small exports consume the public Web stream through Response.arrayBuffer(); bulk exports drain to a counting Node writable. Normal Drizzle constructs a select, calls .all(), runs JSON.stringify(), then encodes/drains the result through the corresponding destination. Imports, schema declarations, opening/closing connections and constructing the Drizzle database wrapper are outside request timing. Module imports and setup are included in process memory. HTTP, remote database latency, disk output and compression are outside this run.

## Main comparison

Each time is the median of five fresh-worker medians. Peak RSS below is the **highest observed process high-water mark across those five workers**, including imports, correctness verification, warmup and timed requests. The median of the five memory peaks is also reported. RSS is process memory, not V8 heap size or incremental per-request memory.

| Fixture | Method | Total time (ms) | Worker time range (ms) | Median peak RSS (MiB) | Highest observed RSS (MiB) |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 row, warm | Direct ExportLite table | 0.1446 | 0.1403–0.1531 | 108.9 | 109.2 |
| 1 row, warm | Drizzle adapter table | 0.1424 | 0.1379–0.1470 | 215.2 | 215.7 |
| 1 row, warm | Drizzle .all() + JSON.stringify | 0.0695 | 0.0666–0.0701 | 215.1 | 215.8 |
| 1 row, first export / fresh connection | Direct ExportLite table | 0.2422 | 0.2208–0.2457 | 80.1 | 80.4 |
| 1 row, first export / fresh connection | Drizzle adapter table | 0.2383 | 0.2246–0.3134 | 215.4 | 215.7 |
| 1 row, first export / fresh connection | Drizzle .all() + JSON.stringify | 0.1070 | 0.0996–0.1104 | 215.3 | 215.7 |
| 10 rows, warm | Direct ExportLite table | 0.1512 | 0.1438–0.1950 | 109.2 | 109.4 |
| 10 rows, warm | Drizzle adapter table | 0.1476 | 0.1408–0.1541 | 215.1 | 215.7 |
| 10 rows, warm | Drizzle .all() + JSON.stringify | 0.0766 | 0.0735–0.0848 | 215.1 | 215.6 |
| 1,000 rows, warm | Direct ExportLite table | 0.5882 | 0.5596–0.6106 | 114.6 | 116.8 |
| 1,000 rows, warm | Drizzle adapter table | 0.5805 | 0.5639–0.6545 | 246.4 | 246.9 |
| 1,000 rows, warm | Drizzle .all() + JSON.stringify | 0.7875 | 0.7748–0.8959 | 215.5 | 216.0 |
| 1M narrow rows | Direct ExportLite table | 367.3788 | 364.4948–382.6458 | 150.9 | 153.5 |
| 1M narrow rows | Drizzle adapter table | 371.1981 | 366.6367–451.0675 | 287.2 | 290.9 |
| 1M narrow rows | Drizzle .all() + JSON.stringify | 942.5605 | 934.2494–1354.9252 | 797.8 | 828.2 |
| 100K wide rows | Direct ExportLite table | 142.5308 | 141.5819–160.2725 | 186.7 | 205.6 |
| 100K wide rows | Drizzle adapter table | 144.2768 | 143.6037–148.4386 | 299.1 | 324.9 |
| 100K wide rows | Drizzle .all() + JSON.stringify | 457.3627 | 444.3774–603.9944 | 1218.6 | 1237.8 |

For the two bulk fixtures:

- **1M narrow rows:** the table adapter took 1.04% more median time than direct ExportLite, and was **2.54× faster** than normal Drizzle with **64.9% lower highest observed RSS**.
- **100K wide rows:** the table adapter took 1.23% more median time than direct ExportLite, and was **3.17× faster** than normal Drizzle with **73.8% lower highest observed RSS**.

The direct and adapter table timing ranges overlap. There were slower workers, particularly one narrow adapter worker and one normal-Drizzle round, so the small median difference does not demonstrate a consistent adapter slowdown. Normal Drizzle is faster for the 1- and 10-row responses. At 1,000 rows the adapter is faster in median, but its process peak is higher than normal Drizzle. The strongest time and memory gains here occur on the large exports.

## Drizzle already loaded in the application

The main direct ExportLite workers import only ExportLite; adapter workers also import Drizzle. The additional control imports Drizzle, declares the same schema, wraps the connection, then calls direct ExportLite on that native connection. This is useful for applications already using Drizzle. These are unbundled Node ESM processes, and their import overhead is part of the reported RSS.

| Fixture | Method | Total time (ms) | Median peak RSS (MiB) | Highest observed RSS (MiB) |
| --- | --- | ---: | ---: | ---: |
| 1M narrow rows | Direct ExportLite, Drizzle loaded | 373.7666 | 285.6 | 286.0 |
| 1M narrow rows | Drizzle adapter table | 371.1981 | 287.2 | 290.9 |
| 100K wide rows | Direct ExportLite, Drizzle loaded | 141.8886 | 306.2 | 330.4 |
| 100K wide rows | Drizzle adapter table | 144.2768 | 299.1 | 324.9 |

The adapter and direct ExportLite have similar bulk RSS when both processes load Drizzle. This control indicates that most of the extra process memory versus bare ExportLite comes from the loaded Drizzle runtime and associated allocation/GC state. A process high-water mark cannot isolate a precise retained-memory cost for the adapter itself.

## Select-builder path

Passing a Drizzle select to exportQuery() currently uses the row-streaming query path. Integer-key 256-row batching applies to exportTable(). The controls below compare the same ordered full-table projection, including constructing the Drizzle select inside the request timer.

| Fixture | Method | Total time (ms) | Worker time range (ms) | Median peak RSS (MiB) | Highest observed RSS (MiB) |
| --- | --- | ---: | ---: | ---: | ---: |
| 1M narrow rows | Direct ExportLite query | 768.6490 | 763.8486–780.2874 | 119.7 | 120.3 |
| 1M narrow rows | Drizzle adapter select | 775.3470 | 760.1027–906.6982 | 216.0 | 219.4 |
| 1M narrow rows | Drizzle .all() + JSON.stringify | 942.5605 | 934.2494–1354.9252 | 797.8 | 828.2 |
| 100K wide rows | Direct ExportLite query | 309.3102 | 307.8313–314.5312 | 160.9 | 170.8 |
| 100K wide rows | Drizzle adapter select | 310.7334 | 308.2890–314.4854 | 246.2 | 250.3 |
| 100K wide rows | Drizzle .all() + JSON.stringify | 457.3627 | 444.3774–603.9944 | 1218.6 | 1237.8 |

Select-builder export performance is close to direct ExportLite query streaming. Both query paths are slower than the batched table path on these fixtures. The adapter select is still faster and uses less peak RSS than normal Drizzle plus stringify on both large fixtures; it does not receive the full table-batching speedup.

## Fairness and verification

- **120 sequential fresh workers:** five per fixture/method. Rotate the three main method positions across cases and rounds; alternate additional controls. No concurrent workers or forced garbage collection.
- Each worker verifies output, warms up, and measures three request batches. Each batch contains 200 requests for warm 1/10-row cases, 50 for first-export and 1,000-row cases, or one complete bulk export. **22,680 timed exports** in total. The first-export case opens a fresh connection and Drizzle wrapper outside each timer; file-system reads are warm and this is not a cold-start or cold-disk benchmark.
- Reuse schemas/column selections across requests. Every ExportLite call prepares a fresh data statement. Normal Drizzle and the adapter select build a fresh select on every request; no explicit prepared-query or result cache is used.
- All methods project id, name, note, active in that order. active uses numeric integer mode, matching the existing fixture contract. All **120 workers match the expected encoded byte length and SHA-256**, including Unicode and varied text. Timed requests additionally check output length; ExportLite checks exported row counts.
- Narrow output: **83,369,847 bytes (79.51 MiB), 1,000,000 rows**. Wide output: **100,920,480 bytes (96.25 MiB), 100,000 rows**, including the original long-record spikes. Small and large database-file digests match the preceding declared-table comparison before and after the run.
- The direct and Drizzle-adapted table APIs prepare **exactly identical batched SQL**, one statement each, verified separately after timing. The shared fixed 256-row planner and 64 KiB output buffering remain in use.
- All tracked package source/build files and benchmark inputs match their pre-run SHA-256 fingerprints. A 13-worker smoke run and an additional Drizzle-loaded control passed before the full run. The existing 283-test implementation was benchmarked without package-code changes.

## Reproduce and inspect

Use the exact Node executable recorded in configuration.json to run outputs/drizzle-adapter-benchmark/run.mjs from the workspace root. Add --smoke for the short run. The fixture manifest contains the original database locations and digests. check-sql.mjs verifies the shared batched SQL.

- [Summary CSV](../../outputs/drizzle-adapter-benchmark/comparison/summary.csv)
- [Raw workers](../../outputs/drizzle-adapter-benchmark/comparison/all.json)
- [Configuration, versions and fingerprints](../../outputs/drizzle-adapter-benchmark/comparison/configuration.json)
- [Byte validations](../../outputs/drizzle-adapter-benchmark/comparison/validation.json)
- [Identical SQL verification](../../outputs/drizzle-adapter-benchmark/sql-validation.json)
- [Worker source](../../outputs/drizzle-adapter-benchmark/worker.mjs)
- [Runner source](../../outputs/drizzle-adapter-benchmark/run.mjs)
