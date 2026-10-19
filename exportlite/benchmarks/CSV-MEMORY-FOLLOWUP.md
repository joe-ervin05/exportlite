# CSV memory: Drizzle setup and native batch buffers

Measured October 19, 2026 on Apple M1 Pro with the same Node **26.12.0** executable, SQLite **3.53.4** and immutable narrow/wide/JSON-cell fixtures as the [native CRC32 comparison](NATIVE-CRC.md). Baseline: `62ef56d498e945a3cd720f79edad8097ac293b78`. Registry checks confirm better-sqlite3 13.0.3, Drizzle 0.45.4, zip-stream 7.0.5 and tsdown 0.23.1 remain current; dependencies are unchanged.

**The benchmark setup is corrected; the production runtime stays unchanged.** The old JSON-cell comparison initialized Drizzle only for ExportLite and mixed CommonJS schema imports with the ESM adapter. That overstated how much of the package/manual memory difference belonged to CSV encoding. Matching setup narrows the ZIP gap substantially, but a real native-buffer/GC tradeoff remains. None of ten small runtime candidates demonstrated a general memory improvement without a speed or memory regression elsewhere.

## Matching setup instead of subtracting unrelated peaks

The maintained worker now initializes the same Drizzle driver and schema for manual JS and the adapter whenever the fixture uses Drizzle JSON metadata. Manual JS still reads native driver rows and uses its specialized CSV encoder. Package and schema imports default to ESM; `CSV_BENCH_PACKAGE_FORMAT=cjs` selects matching CommonJS imports. Diagnostic controls retain the old mixed-format and no-ORM references.

Current memory and the process RSS high-water mark are recorded immediately before the first export. Whole-process peaks remain whole-process peaks: subtracting setup RSS does not yield precise CSV-only memory because GC scheduling and reuse of existing heap/allocator pages differ. No startup memory is silently removed from the results.

On this unbundled Node runtime, the JSON fixture's ESM setup already peaks at about **192 MiB before exporting a row**; matching CommonJS setup peaks around **75 MiB**. This is an observed import/startup effect in this environment, not a universal Drizzle memory requirement or a recommendation to change an application's module format. Both formats are included to distinguish setup from encoding.

## Matched results

Five rotating rounds, sequential fresh workers, natural GC. Each worker verifies output, warms twice, then measures three batches of two exports: nine exports total. Time includes API planning, encoding, ZIP and destination completion; setup/imports are excluded from time but included in peak RSS. The sink counts bytes without disk or HTTP delivery. No profiling hooks, forced GC, builds or other benchmarks ran alongside these timing workers.

All paired plain CSV and ZIP hashes match across encoders, module formats and candidate builds. Plain bytes also match the independently generated fixture CSV. ZIP retains level 1, memLevel 9 and 256 KiB compression output chunks. ExportLite uses native CRC32; manual JS uses the installed unmodified ZIP writer.

Values below are **ExportLite / manual JS**. Memory is the median of five whole-process peaks, not a hard cap.

| Scenario | Plain time ms | Plain peak RSS MiB | ZIP time ms | ZIP peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| Wide, direct native API, no ORM | 39.2 / 48.1 | 166.0 / 142.8 | 95.5 / 107.6 | 143.9 / 118.7 |
| Same wide fixture, matched ESM Drizzle setup | 39.5 / 47.5 | 285.2 / 214.0 | 94.1 / 109.5 | 263.6 / 221.3 |
| JSON cells, matched ESM Drizzle setup | 46.6 / 178.2 | 278.4 / 198.0 | 48.0 / 191.1 | 243.0 / 204.1 |
| Same JSON cells, matched CommonJS setup | 45.9 / 177.1 | 152.6 / 166.0 | 48.5 / 190.6 | 135.0 / 116.3 |

The deliberately unmatched manual JSON reference peaks at **141.0 MiB plain / 109.8 MiB ZIP** with no ORM setup, illustrating why the earlier comparison needed correction. These are new matched measurements, not memory reductions from a production change. The ordinary wide fixture reaches similar ESM peaks when given Drizzle setup: JSON-valued cells do not explain a unique 100+ MiB encoder overhead.

Highest observed peaks in the five-worker matched groups were **175.8 / 143.8 MiB plain** and **149.7 / 123.1 MiB ZIP** for direct wide exports; matched ESM JSON reached **279.3 / 201.1 MiB plain** and **243.5 / 204.4 MiB ZIP**. The raw summary includes every group's minimum/maximum timings and highest RSS.

## One export versus repeated exports

A separate five-round, 90-worker comparison performs only one hash-verified export per process, with no warmups, timed batches, instrumentation or forced GC. These are memory measurements; no single-export speed claim is made.

| Scenario | One plain export peak MiB | Nine plain exports peak MiB | One ZIP export peak MiB | Nine ZIP exports peak MiB |
| --- | ---: | ---: | ---: | ---: |
| Wide, no ORM | 98.6 / 90.2 | 166.0 / 142.8 | 109.5 / 101.6 | 143.9 / 118.7 |
| JSON cells, matched ESM | 209.3 / 192.9 | 278.4 / 198.0 | 212.4 / 197.0 | 243.0 / 204.1 |
| JSON cells, matched CommonJS | 108.3 / 133.6 | 152.6 / 166.0 | 112.5 / 106.0 | 135.0 / 116.3 |

The single-export gap is much smaller, and plain CommonJS JSON favors ExportLite. The repeated workload remains useful for a long-lived server, but its peak must not be described as the additional memory needed for one export.

## What the profiles show

Separate instrumented workers track native SQLite batch/backing-store allocations, writer copies, setup/export memory, natural GC and finalizers. The queue probe also intercepts Node Duplex writes to observe the owned PassThrough/compressor stages. Profiling changes allocation/GC behavior; its timings and exact peaks are diagnostic, not the comparison above.

1. **The driver allocates a new Buffer for each BLOB batch.** better-sqlite3 13.0.3 calls `Napi::Buffer<char>::Copy` in `src/util/data.cpp`. Across nine exports, wide creates about **125.5 MiB** of native batch data; JSON creates **102.2 MiB**. This is cumulative allocation, not simultaneous retained data.
2. **The redundant-copy fix is still working.** The writer passes a sole Buffer directly. Wide incurs only **2.36 MiB** of large concatenation copies across nine exports, and JSON **1.73 MiB**, mostly the first header-plus-batch write. Copying the complete export again is not the remaining problem.
3. **GC cadence differs.** Native table exports create few ordinary JS objects, so unused external Buffer backing stores can accumulate between collections. Manual JS creates many rows/strings/parsed JSON values and triggers more frequent collection. Representative wide plain profiles see roughly **64–65 MiB** of batch backing stores versus single-digit MiB for manual JS. This trades lower JS allocation/CPU work for a higher transient Buffer high-water mark.
4. **Write queues are much smaller than the gap.** In the dedicated probe, the largest pending wide writes are about **296 KB** at the input and **275 KB** at the compressor; JSON is about **204 KB / 202 KB**. The output destination is smaller. These counters are per-stage pending writes, not a sum of unique memory or a measurement of every zlib/SQLite internal allocation.
5. **The observed buffers are collectible.** After work and connection close, diagnostic GC brings tracked array-buffer memory back to about **0.1 MiB**. Four 99-export profiles allocate about **1.35 GiB wide / 1.10 GiB JSON** cumulatively while array-buffer peaks remain about **30–70 MiB**, followed by the same post-GC return. RSS can remain above live-object memory; the runtime/allocator's retained pages and heap capacity also count. This supports delayed collection rather than retention of complete export contents, within the tested runs; it is not a universal memory ceiling or indefinite leak qualification.

Node includes Buffer backing stores in `arrayBuffers` and in `external`; those values must not be added together. RSS also includes other process memory. [Node memory accounting](https://nodejs.org/api/process.html#processmemoryusage).

## Small fixes tested and rejected

The initial three-round screen covers seven candidates and 126 fresh workers. A second three-round size screen adds 192/512/1024-row batches and 72 workers. The promising 128-row candidate receives the five-round matched recheck above. No sizing policy, selector or public option is added.

| Candidate | Result |
| --- | --- |
| Yield every 256 or 512 rows | No consistent wide/JSON memory improvement; narrow slowdown in the screen |
| Fixed 128-row batches | Wide ZIP median RSS improves **143.9 → 127.3 MiB** and time stays comparable (**95.5 → 94.9 ms**), but narrow plain/ZIP take about **3.5% / 2.8%** longer; JSON ZIP takes **3.1%** longer and uses more memory |
| Fixed 64-row batches | More coalescing/overhead; wide and JSON process peaks can increase |
| Fixed 192-row batches | No general memory win; wide plain grows and narrow plain slows in the screen |
| Fixed 512/1024-row batches | Some faster cases, but larger wide/narrow/JSON peaks |
| SQLite text batches instead of BLOBs | Wide plain is about **64% slower**, JSON plain about **46% slower** in the screen; does not produce a general ZIP memory win |
| ZIP output chunks of 64/128 KiB | Small/inconsistent memory changes with speed costs elsewhere |

The screens are not release qualification for those candidates, and their cohorts must not be combined into a single median. Text delivery also needs separate UTF-16 declaration-guard qualification before adoption. Native Buffer detachment/recycling and a global GC policy were excluded: they would introduce ownership/reliability concerns or new runtime policy. The package keeps fixed **256-row** batches, the existing buffers, streaming fallbacks, one export statement and native checksums.

## Changes and validation

Only benchmark code and documentation change. The maintained worker now matches ORM setup and module format, records setup memory separately, and supports opt-in diagnostic checkpoints and single-export workers. The regular timing runner rejects missing timings from diagnostic-only workers. ESM and CommonJS functional smoke runs cover 24 fresh workers and matching output hashes.

Build, types, lint and **469 tests** pass. An initial suite run alongside fixture preparation failed the existing Turso early-abort session-count assertion; the isolated **84-test Turso run** and full **469-test rerun** passed without runtime/test changes. Both logs are retained. All source files and package/build configuration match the baseline; all 12 declaration files are identical. The 14 generated JS files match after normalizing build-location chunk filenames and region/source-map comments. No new Turso Cloud or cross-platform performance claim is made.

## Reproduction and evidence

The Node executable SHA-256 remains `12ccc7c7d8b9b33ac0740fc7c2590d2aba14ccfa0a40f3d3f7a6c4c60c87f07c`. Use Node 26.12.0 for workers and Node 24.19.0 for builds. From a fresh checkout with pinned dependencies installed:

```sh
(cd exportlite && /path/to/node24 node_modules/tsdown/dist/run.mjs)
CSV_BENCH_DIR="$PWD/outputs/csv-deep" BENCH_FIXTURES=tiny BENCH_ROUNDS=1 /path/to/node26 exportlite/benchmarks/csv-performance/run.mjs
BUILD_NODE=/path/to/node24 /path/to/node26 exportlite/benchmarks/csv-performance/prepare-baseline.mjs 62ef56d498e945a3cd720f79edad8097ac293b78 outputs/csv-memory-next/baseline
BUILD_NODE=/path/to/node24 /path/to/node26 outputs/csv-memory-next/build-candidates.mjs
/path/to/node26 outputs/csv-memory-next/matched.mjs
MEMORY_SINGLE=1 /path/to/node26 outputs/csv-memory-next/matched.mjs
/path/to/node26 outputs/csv-memory-next/profile.mjs
PROFILE_LONG=1 PROFILE_DIRECTORY=long-profiles /path/to/node26 outputs/csv-memory-next/profile.mjs
PROFILE_PROBE=probe.mjs PROFILE_PACKAGE_ONLY=1 PROFILE_DIRECTORY=queues /path/to/node26 outputs/csv-memory-next/profile.mjs
```

The default candidate builder creates the seven initial candidates, including the 128-row build used by the matched runner; it refuses existing directories. Additional size candidates use `CSV_MEMORY_CANDIDATES=batch192,batch512,batch1024`. Generated builds and databases are not committed. Fixtures come from the maintained CSV runner; create missing ones before the archived controls. The scripts have fixed evidence paths, so use a fresh directory/checkout when reproducing rather than overwriting another run.

Evidence: [matched configuration](../../outputs/csv-memory-next/matched/configuration.json), [all 140 matched workers](../../outputs/csv-memory-next/matched/all.json), [matched summary](../../outputs/csv-memory-next/matched/summary.json); [single-export configuration](../../outputs/csv-memory-next/single/configuration.json), [all 90 workers](../../outputs/csv-memory-next/single/all.json), [single-export summary](../../outputs/csv-memory-next/single/summary.json); [initial candidate screen](../../outputs/csv-memory-next/screen/summary.json), [additional size screen](../../outputs/csv-memory-next/size-screen/summary.json), [profile analysis and phase checkpoints](../../outputs/csv-memory-next/analysis.json), [qualification](../../outputs/csv-memory-next/qualification.json), [initial test output](../../outputs/csv-memory-next/tests.txt), [full rerun](../../outputs/csv-memory-next/tests-recheck.txt). Profiling uses explicit GC only after all exports and connection close; none is added to production.
