# Wide-query memory investigation

The higher phase 2 median peak RSS repeated, but profiles point to temporary string lifetime and garbage-collection timing rather than an increased live dataset. Encoding a completed writer buffer to UTF-8 before awaiting its write substantially reduces this overhead. It adds one `Buffer.from` call where Node previously performed the same encoding inside `Writable.write`.

## Findings

The phase 1 versus phase 2 comparison repeated at **159.1 versus 181.2 MiB** median peak RSS (+13.9%), with timing within 0.2%. However, an unchanged phase 2 build produced individual peaks from about 133 to 239 MiB across the subsequent uninstrumented workers. Detailed sampling also changed the before/after relationship. The exact phase 2 edit responsible for the original shifted median was not isolated; changes to cleanup and argument passing did not give a consistent improvement.

The query fallback returns individual JSON strings from SQLite. The writer joins these into roughly 64 KiB output chunks, then awaits a write that encodes the string to a Buffer. The pending asynchronous scope/callbacks can retain the joined string alongside the bytes. Wide Unicode records make those temporary strings expensive. Table exports normally use SQLite byte batches and largely avoid this path.

The change encodes the joined string before entering the asynchronous send. The send then receives only a Buffer, so its callbacks cannot retain that joined string. Buffering thresholds, SQL, batching, callbacks/drain handling, cancellation, file ownership and ZIP configuration stay the same. The writer's mixed string/Buffer path already used byte buffers and is unchanged.

Three natural-GC traces per version support this explanation:

| Whole diagnostic worker | Before | After |
| --- | ---: | ---: |
| Cumulative allocation reported by GC | 499–506 MiB | 501–504 MiB |
| Bytes promoted to older heap generations | 14.6–28.1 MiB | 0.72 MiB |
| Largest heap capacity at a recorded GC | 40.5–75.5 MiB | 19.3–29.3 MiB |
| Minor collections | 46–57 | 88–93 |
| Major collections | 1–2 | 0 |

These are traced workers, including imports and shutdown, not timing results. Allocation totals cover GC intervals, not every allocation through process exit. A separate diagnostic collection after nine exports left **5.9–6.2 MiB** of used JavaScript heap before and **5.7–6.0 MiB** after, with approximately **0.14 MiB** of ArrayBuffers in both. This does not indicate a retained-row leak. Forced GC is used only in that separate diagnostic; the package and performance benchmarks use natural GC.

## Performance

Compared phase 2 (`b45f9bb`, runtime implementation `9a55f2a`) with the one-line writer change using the same **Node v26.12.0** executable, fixture generator and seed 20261017. The wide fixture has 15,000 varied rows with nominal text width 1024. Each fresh worker verifies output, warms twice, then runs three batches of two timed exports. Paired order alternates; these results are medians of seven worker medians. Time includes query construction, execution, JSON generation, UTF-8 delivery, completion and compression when enabled. Peak RSS covers the entire worker, including imports, verification and warmup.

| Wide direct query | Before time | After time | Before median peak RSS | After median peak RSS | Highest observed peak, before → after | Output bytes, both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON | 48.13 ms | 49.00 ms (+1.8%) | 159.1 MiB | 118.7 MiB (−25.4%) | 187.7 → 121.6 MiB | 15,094,262 |
| ZIP | 106.77 ms | 106.80 ms (+0.02%) | 125.0 MiB | 111.2 MiB (−11.1%) | 128.0 → 111.4 MiB | 4,053,329 |

The independent seven-pair plain-JSON recheck measured 48.57 → 48.03 ms (−1.1%) and 156.8 → 118.3 MiB (−24.5%). The memory improvement repeats; timing varies around the original speed. This is not a guarantee of a fixed memory ceiling on every Node version, record distribution or destination.

A three-pair, 24-case matrix covers tiny/narrow/wide fixtures, direct and Drizzle table/query APIs, and JSON/ZIP output. All bulk timings stayed within approximately 2.4%; no case increased median peak RSS by more than 1.2%. An initial tiny table timing increase of 14.9% (0.215 → 0.246 ms) did not repeat: the seven-pair recheck measured 0.222 → 0.217 ms. Wide direct-query memory also improved in that matrix, from 182.8 → 117.8 MiB for JSON and 126.0 → 111.1 MiB for ZIP. Drizzle's process high-water measurement includes its larger import/setup footprint, which can mask export-specific improvements.

Every comparison preserves encoded byte counts and SHA-256, including complete ZIP files. The full **378-test** suite passes, covering Unicode, Web/Node streams, asynchronous callbacks and drain, cancellation, output failures, owned-file cleanup, independent ZIP decoding and local Turso protocol behavior. Build, public ESM/CommonJS type checks and lint pass. Current npm releases were checked; no dependencies or supported versions changed. This investigation uses local SQLite and protocol tests, not a live Turso service.

## Reproduction and evidence

Build `b45f9bb` separately with the pinned dependencies, retaining access to its `node_modules`. Build the candidate normally in `exportlite/`. From the repository root, use the recorded Node 26.12.0 executable:

```sh
EXPORTLITE_BEFORE=/path/to/phase2/dist \
BENCH_ROUNDS=7 BENCH_METHODS=query BENCH_FIXTURES=wide \
BENCH_COMPRESSIONS=none,zip BENCH_OUT=/tmp/exportlite-wide-comparison \
node outputs/phase2/compare.mjs

# Separate diagnostic runs; never use these timings as performance results.
node outputs/wide-query-memory/trace.mjs /path/to/phase2/dist exportlite/dist /tmp/exportlite-gc-traces
node outputs/wide-query-memory/profile.mjs fixture
node --expose-gc outputs/wide-query-memory/profile.mjs /path/to/phase2/dist /tmp/exportlite-before-profile.json
node --expose-gc outputs/wide-query-memory/profile.mjs exportlite/dist /tmp/exportlite-after-profile.json
```

The profiler defaults to boundary snapshots; `PROFILE_WRITES=1` samples every flushed chunk and noticeably perturbs GC behavior. The fixture command reuses an existing diagnostic fixture; delete only that generated `outputs/wide-query-memory/wide.sqlite` file to regenerate it.

- [Source revisions and diagnostic variant definitions](../../outputs/wide-query-memory/baseline.json).
- Isolated five-pair experiments: [early encoding](../../outputs/wide-query-memory/test-encode-before-send/summary.json), [returning send](../../outputs/wide-query-memory/test-return-send/summary.json), [old cleanup](../../outputs/wide-query-memory/test-old-finally/summary.json) and [old argument count](../../outputs/wide-query-memory/test-four-arguments/summary.json). Only early encoding consistently reduced both median and highest observed peak RSS.
- [Phase 1/2 reproduction](../../outputs/wide-query-memory/reproduce/summary.json) and [identical-build control](../../outputs/wide-query-memory/aa/summary.json).
- [24-case matrix](../../outputs/wide-query-memory/matrix/summary.json), [seven-pair recheck](../../outputs/wide-query-memory/recheck/summary.json) and [final JSON/ZIP comparison](../../outputs/wide-query-memory/final/summary.json). Each folder contains all worker results and build/runtime/fixture hashes.
- [GC trace runner](../../outputs/wide-query-memory/trace.mjs), [recorded GC events and totals](../../outputs/wide-query-memory/trace-recheck/gc-traces.json), [heap profiler](../../outputs/wide-query-memory/profile.mjs) and [post-GC snapshots](../../outputs/wide-query-memory/post-gc/before-0.json).
