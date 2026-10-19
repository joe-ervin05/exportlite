# Remaining aggregation gap and UTF-8 streaming

Measured October 17, 2026. The baseline here already contains the boundary-query optimization from [batch profiling](BATCH-PROFILE.md). Its exact compiled implementation and source snapshot are preserved in `baselines/pre-stream-tuning/`.

There is another useful internal change: retain SQLite's JSON as UTF-8 bytes through the writer. It removes a substantial text conversion cost for varied records, while barely helping the original ASCII-only fixture. Fixed 256-row batches, one export statement, ordering, public options, output buffering, cooperative yields and reliability behavior remain intact.

## What remains after boundary tuning

On the original million-user fixture, the optimized byte path takes **166.56 ms**, versus **126.93 ms** for full aggregation returning bytes. The roughly 40 ms gap separates approximately into:

- **24 ms in batched SQL/driver work:** prepared batch consumption takes 151.35 ms. The current algorithm still walks boundary keys as well as payloads, performs indexed seeks and recursive steps, and delivers 3,907 separate native results. Full aggregation accumulates one result.
- **15 ms in the streaming producer/output path:** framing, buffering, completion checks, writable callbacks and cooperative event-loop scheduling. These estimates compare separate median controls; they are not an exact per-request accounting.

A rotated, single-process diagnostic disabled only the cooperative yield branch. It reduced median time from 165.37 to 155.60 ms. **That diagnostic is not a production optimization:** the original yield every 2,048 rows is still present, allowing cancellation, disconnects and other event-loop work to arrive. Existing abort tests continue to enforce that behavior.

I also tested moving ordering into the aggregate to remove the ordered payload subquery. SQLite used temporary aggregate-ordering storage and became slower: 149.86→273.45 ms on the original fixture, 346.81→502.96 ms on varied small records, and 134.24→227.20 ms on varied large records. Removing ordering altogether was faster in an earlier diagnostic but would violate the table export's ordering contract. Aggregate input ordering matters for JSON/string aggregation. [SQLite aggregate documentation](https://www.sqlite.org/lang_aggfunc.html)

These results do not establish a theoretical speed limit. They show that the remaining original-fixture gap is mainly work associated with this streaming design, rather than another large, easily removed conversion cost.

## The UTF-8 byte change

Previously, SQLite built JSON, better-sqlite3 decoded it into JavaScript strings, and the output pipeline encoded those strings into UTF-8 again. That round trip is cheap for the original short ASCII labels, but expensive for the varied fixtures.

The planner now returns `CAST(batch_json AS BLOB)` for UTF-8 databases. The adapter accepts a Buffer batch, the export loop uses byte slices to remove JSON array brackets, and the existing writer collects binary fragments without converting them back into text. Framing is joined at the same buffer threshold. No JSON parsing or JS row objects are introduced, and input buffers are not mutated.

SQLite casts text to BLOB using the database encoding. The existing table-metadata query now also reads that encoding; UTF-16 databases retain the prior text path and still produce UTF-8 output. This guard is necessary for correctness. [SQLite CAST documentation](https://www.sqlite.org/lang_expr.html#castexpr)

The public API and declaration files are unchanged. The core build grows by approximately 0.75 kB uncompressed. There is no new dependency, option, size estimator, SQLite extension or custom function. Metadata checking adds no separate driver query, and the export remains one prepared data statement.

## Complete public Node writable exports

Times are milliseconds, including JSON generation and output completion/UTF-8 encoding where needed. Each total is the median of five fresh workers, each reporting the median of three timed responses after correctness verification and warmup.

| Fixture | Previous text batches | Byte batches | Less time | Full SQLite, text | Full SQLite, bytes |
|---|---:|---:|---:|---:|---:|
| Original: 1M users, 22.89 MiB | 168.55 | 166.56 | 1.2% | 131.14 | 126.93 |
| Varied small: 1M rows, 79.51 MiB | 468.88 | 368.93 | 21.3% | 434.70 | 324.69 |
| Varied large: 100K rows, 96.25 MiB | 341.43 | 144.22 | 57.8% | 315.23 | 133.99 |

The byte optimization applies to full aggregation too. The last column is the fairer optimized full-response baseline; ExportLite does not beat it in these median comparisons. Full aggregation still retains the complete JSON value before delivery.

The measured sink allocates UTF-8 buffers for incoming strings and accepts incoming buffers directly. Byte batches therefore record zero additional sink-encoding time. Native byte creation/copying and output buffer joins remain inside measured generation/pipeline time; no work has been moved outside the timer.

Prepared batch SQL/driver consumption, including minimal byte counting:

| Fixture | Text batches | Byte batches |
|---|---:|---:|
| Original users | 151.60 | 151.35 |
| Varied small | 433.80 | 353.52 |
| Varied large | 250.82 | 134.97 |

This isolates the large effect of driver text conversion on varied data. The full producer also avoids re-encoding and text framing copies.

## Default Web stream, ZIP and fallback controls

These controls use three fresh workers per case, with the same verification/warmup/three-sample schedule.

| Fixture and output | Before | After |
|---|---:|---:|
| Original users, Web stream | 171.04 | 168.71 |
| Varied small, Web stream | 472.78 | 372.52 |
| Varied large, Web stream | 341.73 | 146.14 |
| Varied small, ZIP Web stream | 828.35 | 748.85 |
| Varied large, ZIP Web stream | 969.07 | 881.39 |
| Original users, query row fallback | 649.73 | 657.65 |
| Varied large, query row fallback | 384.23 | 394.58 |

ZIP compression settings remain level 1 and a 256 KiB zlib buffer. Its improvement is approximately 9–10%, smaller than plain output because compression still does substantial work. Encoded ZIP bytes and hashes are identical before/after. Independent decoding additionally verifies the JSON digest and CRC-32.

Custom query/other row fallbacks retain their text producer. Their controls took 1–3% more time in this run; the shared writer now handles binary fragments too. This change is not a speed improvement for every path.

Later control workers showed substantial host-time variation, visible in the raw ranges. For example, varied-large Web totals spanned 334–448 ms before and 146–175 ms after. No observations were removed. Use the contemporaneous comparisons here rather than comparing absolute times between this and older reports.

## Memory tradeoff

Whole-process peak RSS, median across the five Node writable workers, MiB:

| Fixture | Before | After | Full SQLite, bytes |
|---|---:|---:|---:|
| Original users | 94.7 | 116.1 | 222.4 |
| Varied small | 97.9 | 150.5 | 562.0 |
| Varied large | 264.8 | 191.0 | 662.1 |

**Small-record RSS increases approximately 21–53 MiB; large-record RSS decreases approximately 74 MiB.** These are repeated-response process high-water marks, not per-response allocations. Imports, verification, warmups, Buffer allocation and natural GC all contribute. The change improves varied-text throughput, not memory universally. Buffer allocation/GC behavior is a plausible contributor to the higher small-record peaks, but it was not independently isolated in an allocation profile.

Streaming remains fixed at 256 rows per batch and the existing 64 KiB output target. The complete response is never retained by the streaming implementation. This is not a hard process-memory bound, and large records can still exceed the output target.

## Reliability and validation

- **180 tests pass in five files**, including file cleanup, caller-owned writable behavior, backpressure, cancellation, ZIP finalization, exact 64-bit numeric JSON and a stable concurrent WAL read snapshot.
- Nine new cases verify native UTF-8 batches, no mutation of input buffers, UTF-16LE/BE databases, both formats, ZIP and plain output across a batch boundary.
- A cancellation test now waits for a genuinely blocked caller write instead of a timer. After cancellation it releases later adapter-buffered writes too, avoiding a timing-dependent test-sink deadlock. It still requires stream rejection and SQLite statement cleanup before the first blocked write is released.
- All 120 fresh workers verified output hashes and byte counts. There were **360 timed responses**, with two untimed responses per worker. ZIP hashes agree before/after; independent archive decoding checks SHA-256 and CRC-32.
- 21 nested/limited-root benchmark-adapter cases still match the original aggregate. This is benchmark compatibility, not new public relationship support.
- Type checking, formatting/lint checks and ESM/CommonJS builds pass. Unit tests use Node 24.19.0; every measured worker asserts Node 26.12.0. Public declaration files and the readable lifecycle adapter are byte-identical to the baseline. The writer's callback/drain, completion and cleanup implementation is unchanged.

## Reproduction and evidence

Same M1 Pro machine and 32 GiB RAM; **Node 26.12.0**, better-sqlite3 **13.0.3**, SQLite **3.53.4**. Current better-sqlite3 and zip-stream versions were rechecked and remain 13.0.3 and 7.0.5. The original and varied fixtures are exactly those recorded in `results/batch-profile/fixtures.json`, with the same digests, seeds, row counts and columns. No dependency versions changed.

Workers run sequentially with rotating method order, warm reads, natural GC, no explicit collection and no enlarged heap limit. Verification hashes, process startup and fixture generation are excluded from timings. HTTP framing, network, TLS, client parsing and actual disk writes are not measured.

Build the package and private matched benchmark entry using the existing development runtime, then run `BENCH_NODE=/path/to/node26 node benchmarks/remaining-gap/run.mjs`. `worker.mjs` uses the matched dependency directory's Node 26 native driver. The original fixture and varied fixtures must be prepared as described in [the prior report](BATCH-PROFILE.md). Run `summarize.mjs`, `validate.mjs` and the optional `yield-diagnostic.mjs` / `aggregate-order.mjs` under Node 26 after the main workers finish; diagnostic variants are never used in production.

- [Summary JSON](results/remaining-gap/summary.json), [CSV](results/remaining-gap/summary.csv), [configuration, order and source fingerprints](results/remaining-gap/configuration.json), [validation](results/remaining-gap/validation.json).
- `results/remaining-gap/raw/` contains every worker; `all.json` combines them. `screen.json` records the initial SQL variants and plans. `aggregate-order.json` and `yield-diagnostic.json` retain the separate ablations.
- `baselines/pre-stream-tuning/manifest.json` identifies the exact preserved previous implementation. Earlier report archives remain untouched.
