# Phase 2 regression checks

Compared the phase 1 build at `95a1a44` with the phase 2 implementation at `9a55f2a`, on the same fixture files and Node **v26.12.0** executable. The implementation shares local delivery setup, preserves primary failures during cleanup and improves remote error diagnostics. Fixed batching, ordering, plan caching, UTF-8 handling, cooperative yields, writer buffering and compression settings are unchanged.

## Method

- Three paired rounds across 24 cases: direct table/query and Drizzle table/query APIs, plain JSON and actual ZIP, and three fixtures. A fresh process runs each variant. Pair order alternates by round.
- Fixtures use the existing generator with seed 20261017: 100 tiny repeated-text rows (width 32), 50,000 varied narrow rows (width 32), and 15,000 varied wide rows (width 1024).
- Each worker verifies output, warms twice, then measures three request batches. Tiny cases run 100 requests per batch and consume Web streams. Bulk cases run two exports per batch into counting Node writables. Reported time is the median of worker medians, per completed export.
- Timing includes per-request statement/query construction, execution, JSON generation, compression when enabled, UTF-8 delivery and completion. Imports and connection/schema setup are outside timing and inside process peak RSS. Drizzle setup uses the same CJS ORM imports in both variants. No forced GC, disk output or network latency.
- The initial comparison used 144 fresh workers. Two targeted five-pair rechecks added 20 workers. Across all 164 workers there were 18,036 timed exports and 164 output-hash verifications. Before/after byte counts and encoded SHA-256 match for every case, including ZIP files.
- Peak RSS is the process high-water mark across imports, verification, warmup and timed batches. It is not retained memory after an export, a heap-only measure, or a per-export allocation total.

## Initial comparison

Times are milliseconds per completed export. Memory is the median worker peak RSS in MiB. These are regression checks for this change, not a new comparison against other libraries.

| Fixture | API | Output | Before ms | After ms | Time change | Before RSS | After RSS |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny | table | none | 0.226 | 0.215 | -4.6% | 93.3 | 94.0 |
| tiny | table | zip | 0.646 | 0.642 | -0.6% | 133.7 | 133.1 |
| tiny | query | none | 0.220 | 0.225 | +2.3% | 87.6 | 87.4 |
| tiny | query | zip | 0.621 | 0.656 | +5.6% | 131.5 | 133.2 |
| tiny | drizzle-table | none | 0.220 | 0.228 | +3.8% | 215.9 | 215.8 |
| tiny | drizzle-table | zip | 0.585 | 0.624 | +6.7% | 234.8 | 230.4 |
| tiny | drizzle-query | none | 0.284 | 0.288 | +1.3% | 215.7 | 216.0 |
| tiny | drizzle-query | zip | 0.683 | 0.795 | +16.4% | 225.0 | 230.2 |
| narrow | table | none | 18.656 | 19.211 | +3.0% | 113.5 | 112.8 |
| narrow | table | zip | 30.843 | 30.007 | -2.7% | 110.6 | 107.9 |
| narrow | query | none | 39.318 | 39.493 | +0.4% | 80.2 | 80.6 |
| narrow | query | zip | 48.008 | 47.724 | -0.6% | 90.4 | 90.6 |
| narrow | drizzle-table | none | 19.903 | 19.917 | +0.1% | 223.1 | 221.0 |
| narrow | drizzle-table | zip | 30.024 | 29.366 | -2.2% | 230.2 | 227.6 |
| narrow | drizzle-query | none | 39.266 | 39.178 | -0.2% | 216.0 | 215.7 |
| narrow | drizzle-query | zip | 47.564 | 47.314 | -0.5% | 215.4 | 215.9 |
| wide | table | none | 22.934 | 22.321 | -2.7% | 182.2 | 174.2 |
| wide | table | zip | 103.983 | 103.956 | -0.0% | 174.2 | 169.0 |
| wide | query | none | 48.594 | 50.054 | +3.0% | 157.6 | 180.7 |
| wide | query | zip | 107.734 | 106.828 | -0.8% | 125.4 | 125.0 |
| wide | drizzle-table | none | 23.036 | 23.475 | +1.9% | 281.9 | 275.0 |
| wide | drizzle-table | zip | 105.182 | 105.781 | +0.6% | 252.2 | 251.3 |
| wide | drizzle-query | none | 47.781 | 47.463 | -0.7% | 247.0 | 246.6 |
| wide | drizzle-query | zip | 111.331 | 109.337 | -1.8% | 244.8 | 247.8 |

## Targeted rechecks

The tiny Drizzle-query ZIP case initially measured 16.4% slower. A separate five-pair run measured 5.5% faster, so the initial timing regression did not repeat. Bulk timing changes in the initial matrix stayed within about 3%.

The wide direct query with plain output showed higher median peak RSS in both runs: 14.6% initially and 12.9% on recheck. In the recheck, the highest observed peak was 185.9 MiB before and 187.7 MiB after (+1.0%). The cause of the shifted median is not established. The row loop and writer buffering are unchanged; this remains a case to retain for stage 4 live-memory/allocation measurements. It is below the plan's 20% RSS investigation threshold. The maintenance change is retained within the plan's review thresholds, with this memory result carried forward to stage 4.

| Case | Before ms | After ms | Time change | Before median RSS | After median RSS | RSS change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tiny / drizzle-query / zip | 0.695 | 0.657 | -5.5% | 225.7 MiB | 227.2 MiB | +0.7% |
| wide / query / none | 49.308 | 47.722 | -3.2% | 158.2 MiB | 178.5 MiB | +12.9% |

## Reliability and scope

The complete suite passes **378 tests**, including stream ownership, cancellation, backpressure, cache/schema behavior, declared projections, native and Drizzle APIs, independent ZIP decoding/CRC, protocol framing, session reuse/expiry, queued cancellation and awaitable shutdown. New fault-injection checks cover simultaneous primary and cleanup failures, preserved completed files after failed client close, HTTP status, bounded provider codes and sanitized transport causes. Build, ESM/CommonJS public type consumers and formatting/lint also pass.

Remote failure paths changed; healthy remote production, session serialization and retry rules did not. The local HTTP protocol suite covers them. Live Turso qualification and a new cloud-performance measurement are outside this phase.

## Reproduction and evidence

Build commit `95a1a44` in a separate checkout with its pinned dependencies, and retain its `dist` with access to those dependencies. Build the candidate in `exportlite/`. From the repository root, use the recorded Node 26.12.0 executable:

```sh
EXPORTLITE_BEFORE=/path/to/phase1/dist node outputs/phase2/compare.mjs
```

The default candidate is `exportlite/dist`; `EXPORTLITE_AFTER` can select another build. Optional `BENCH_METHODS`, `BENCH_FIXTURES`, `BENCH_COMPRESSIONS`, `BENCH_ROUNDS` and `BENCH_OUT` select targeted rechecks. The script's default before-build location is an unshipped local snapshot; the Git commit supplies its source.

- [Runner](../../outputs/phase2/compare.mjs), [baseline source hashes](../../outputs/phase2/baseline.json), [build/runtime/fixture configuration](../../outputs/phase2/configuration.json).
- [Initial worker measurements](../../outputs/phase2/all.json) and [summary](../../outputs/phase2/summary.json).
- [Tiny ZIP recheck](../../outputs/phase2/recheck/summary.json) and [wide-query recheck](../../outputs/phase2/recheck-wide-query/summary.json); each folder also retains configuration and worker measurements.
