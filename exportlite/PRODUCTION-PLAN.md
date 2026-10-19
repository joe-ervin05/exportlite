# ExportLite production readiness plan

Prepare a small, dependable Node.js package for exporting SQLite data as JSON, JSONL and single-file ZIP downloads. Preserve the existing speed, streaming and reliability work. Reach an initial stable release by tightening contracts, validating real integrations and improving distribution, with a separate qualification gate for Turso.

Planning baseline: October 18, 2026. This is a work plan; unchecked items are not completed features or verified release claims.

## Product scope

The primary user is a Node.js developer exporting large SQLite datasets to a file or HTTP response, directly or through an existing Drizzle schema. Regular JSON responses are supported through Web streams, with explicit application-level typing and lifecycle handling.

| Area | Initial release commitment |
| --- | --- |
| Local SQLite | Stable support through better-sqlite3 on the tested Node and platform matrix |
| Drizzle | Stable adapter for the tested SQLite drivers, supported field modes and documented version range |
| Turso HTTP | Experimental until the live qualification gate passes; local release can proceed independently |
| Formats | JSON, JSONL, CSV and one exported file inside a streaming ZIP |
| Destinations | Web readable by default; existing file paths and Node writable options retained |
| Execution | Fixed 256-row batches for eligible tables; row streaming for other tables and queries |
| Ownership | Caller owns database clients and supplied destinations; package owns its created files and internal stages |

Keep one package with optional driver peers and the existing core, Drizzle and Turso entry points. Preserve both ESM and CommonJS. Keep automatic local column discovery alongside declared columns. Do not rename or redesign the public API without a concrete pilot integration requiring it.

Defer relationship builders, generic JS row transformations, arbitrary-query batching, adaptive batch sizing, connection pools, automatic heartbeats, multiple ZIP entries, compression controls and browser or edge runtime support. CSV was added at the user's request after stage 3, with the same streaming contracts. Compression for ordinary HTTP responses stays in the application or server.

## Starting evidence

- The current reliability suite has 363 passing tests, covering stream ownership, backpressure, cancellation, files, ZIP integrity, schema behavior, adapter compatibility and remote session lifecycle.
- Matched local measurements show substantial speed advantages over JS object streaming, with a smaller memory footprint than full SQLite aggregation. Memory is not universally lower than JS streaming.
- The latest concurrent protocol benchmark passed 450 fresh workers, 2,340 timed exports and 1,170 hash-verified warmups. It validates local request/session behavior, not Turso Cloud capacity.
- The package is private and unpublished. Clean package installation, a platform matrix and live Turso qualification remain release work.
- Current checked dependency versions are better-sqlite3 13.0.3, Drizzle 0.45.4, @libsql/client 0.18.0 and zip-stream 7.0.5. Recheck latest versions before implementation and release; preserve matched benchmark pins when comparing performance.

## Delivery order

| Stage | Work | Depends on | Completion evidence |
| --- | --- | --- | --- |
| 1 | Freeze the supported API and data contracts | Current implementation | Support matrix and executable examples agree |
| 2 | Make small internal cleanup and diagnostic improvements | Stage 1 | Targeted diffs, existing tests and affected benchmarks pass |
| 3 | Validate compatibility and package installation | Stages 1 and 2 | CI and clean tarball consumers pass |
| 4 | Establish the release performance baseline | Stage 2 and working package build | One report for the candidate build, including slow consumers |
| 5 | Run small application pilots and finish documentation | Stages 3 and 4 | Working integrations and resolved release blockers |
| 6 | Publish an initial release and stabilize it | Stage 5 | Reproducible artifact, release notes and passing release checklist |
| T | Qualify live Turso support | Stage 1 and an explicitly authorized test endpoint | Live integration evidence supports the advertised remote guarantees |

Run stage T alongside local readiness when access is available. It does not delay a local-only stable support claim. All shipped APIs still receive documented versioning and migration treatment; an experimental support label must be explicit per entry point.

## Stage 1 Freeze the API and data contracts

- [x] Preserve exportTable(), exportQuery(), Web stream defaults, output, signal, end, zip and completion statistics. Keep JSONL as the existing default and make JSON examples specify format explicitly.
- [x] Specify when validation occurs, when consumption starts the read snapshot, and how callers consume or cancel a stream before awaiting its result. Explain errors that occur after HTTP headers or bytes have been sent.
- [x] Document zero metadata preflights for declared and Drizzle exports, and the discovery/schema-version work for automatic local exports. State that primaryKey() declares an existing unique, non-null key; it does not create or verify a database constraint.
- [x] Publish a compact field-mode matrix. Cover nullable text, numbers, booleans, Drizzle JSON text, dates/timestamps, large integers, BLOBs and custom decoders. Provide SQL conversion recipes for unsupported modes; declarations remain contracts rather than per-record JS validation.
- [x] Keep wire types honest. Dates represented as ISO strings have string contracts. Exact integer digits in JSON do not guarantee precision after a JavaScript client parses them; document string casts for large identifiers.
- [x] State driver and transaction boundaries: supported Drizzle adapters, required Turso factory, bypassed Drizzle row mapping/cache hooks, and inability of remote exports to join caller transactions.
- [x] Document the remote queue: one export session per client, ownership through output completion, independent clients for concurrency, queued cancellation, expiry recovery and awaitable close. Show application-level admission limits and AbortSignal usage without adding a library pool or timeout option.

Done when examples and type consumers cover each supported API form, unsupported modes fail clearly, and the README does not promise end-to-end framework type inference or a hard memory cap.

Completed October 18, 2026: the [API and data contracts](docs/contracts.md) define the supported forms and field modes. The build, public type consumers, lint, 368 tests and seven local examples pass; the suite also exercises the Turso example against the local protocol server. The export engine and public API are unchanged. Live Turso qualification remains stage T.

## Stage 2 Simplify delivery and improve diagnostics

- [x] Extract repeated local delivery setup shared by table, query and Drizzle entry points. Keep the synchronous local producer efficient; retain separate local and remote loops where a common async abstraction would add per-record overhead.
- [x] Preserve useful original causes, HTTP status and provider error codes in remote failures. Add focused assertions for those diagnostics and prevent credentials or full request bodies from appearing in errors.
- [x] Keep fixed batches, bounded SQL-plan caching, ordering, UTF-8 byte handling, cooperative yields and the tested writer/ZIP lifecycle. Avoid broad refactoring of working cancellation or client-close logic.
- [x] For a touched failure path, verify that cleanup does not silently replace the primary failure. Preserve owned-file cleanup and successful completed files when later client shutdown fails.
- [x] Leave encoding and bufferSize available, but move them into advanced documentation. Explain that encoding describes the SQLite database and bufferSize is a flush target.

Done when the existing suite, build, public types and lint pass; affected output hashes match; and any repeatable performance change is explained. Run only relevant extra benchmarks for changes in the affected paths.

Completed October 18, 2026: shared local delivery setup, safe remote diagnostics and primary-error preservation are implemented. The build, public types, lint and 378 tests pass. [Paired regression checks](benchmarks/PHASE-2.md) cover 164 fresh workers with matching output hashes. Bulk timings remain within about 3% in the initial matrix; a tiny ZIP timing outlier did not repeat. A wide-query recheck showed +12.9% median peak RSS and +1.0% highest observed RSS; retain that case for stage 4 memory measurements.

The subsequent [wide-query investigation](benchmarks/WIDE-QUERY-MEMORY.md) reduces temporary string retention by encoding completed writer buffers before awaiting writes. Median peak RSS fell 25.4% for wide JSON queries and 11.1% for ZIP, with similar speed and all 378 tests passing. Keep the case in the stage 4 baseline alongside the broader live-memory qualification.

## Stage 3 Validate compatibility and the published artifact

- [x] Establish the source repository at https://github.com/joe-ervin05/exportlite and preserve the implementation milestones and benchmark evidence.
- [x] Add reproducible CI workflows to the source repository before claiming the compatibility matrix is complete.
- [x] Define an explicit supported Node-major matrix and align engines, README and CI. Start with the currently intended 22, 24 and 26 majors, verifying their support status before release. Exercise the advertised minimum Node 22.18.0 and current patches of supported majors.
- [x] Run the full suite on Linux across supported Node majors. Run installation, files, streams, ZIP and adapter checks on macOS and Windows using one supported major initially. Do not claim an untested platform as supported.
- [x] Build ESM, CommonJS and both declaration formats, then test a real packed tarball installed into clean consumer projects. Verify imports, require(), inferred row types and each public entry point.
- [x] Verify optional peer combinations: native-only, Turso-only, Drizzle plus native, and Drizzle plus Turso. Unused drivers must not be required at import time.
- [x] Check archive contents and package metadata. Exclude fixtures, benchmark histories, generated downloads and credentials. Ensure README links resolve from the installed/published package, rather than pointing only to unshipped local reports.
- [x] Keep Drizzle compatibility within the tested range and add compatibility checks before widening it, because the adapter uses some runtime metadata outside public typings.
- [x] Retain independent ZIP decoding and CRC checks. Run the existing greater-than-4-GiB ZIP64 validation for a release candidate; it need not run for every documentation change.

Done when a consumer can install only the peers needed for its documented example and use the actual release tarball successfully on the claimed matrix.

Completed October 18, 2026: the [phase 3 validation report](benchmarks/PHASE-3.md) records all six hosted compatibility jobs passing: Ubuntu on Node 22.18.0, 22.23.3, 24.22.0 and 26.12.0; macOS arm64 and Windows x64 on Node 24.22.0. Each job passes 378 tests, build, public types, lint and five clean npm tarball consumers using both module formats. Package contents and documentation links are audited; the actual greater-than-4-GiB ZIP64 check passes locally. Runtime code and dependency pins are unchanged. The package remains private, and live Turso qualification remains stage T.

CSV added October 18, 2026 at the user's request: `format: "csv"` works across native, Drizzle and experimental Turso exports, including ZIP, fixed batching and streaming fallbacks. The [CSV comparison](benchmarks/CSV.md) records performance, memory, independent parsing and the existing JSON regression checks. The complete suite now has 405 tests; no runtime dependency was added. This does not complete the wider stage 4 qualification.

## Stage 4 Establish the release performance baseline

Use the candidate package build, the existing varied fixtures and exact recorded Node executable for comparisons. Keep the original tiny-record fixture to expose batching overhead. Record versions, build/fixture hashes and timing boundaries so future comparisons stay meaningful.

- [ ] Consolidate the current results into one performance overview. Show full SQLite aggregation, ExportLite table exports, query fallbacks, JS object streaming, naive materialization and normal Drizzle where relevant. Reuse older evidence only with its build and scope identified; rerun comparisons affected by candidate changes.
- [ ] Report plain output and actual ZIP output separately. Record total completion time, time to first output byte, output size, median worker peak RSS, highest observed RSS and variability. Include import/setup memory and make server/client boundaries explicit.
- [ ] Measure table versus filtered-query behavior. Include a realistic Drizzle schema with common field modes, documenting conversions and rejected modes. Quantify the practical effect of falling back to row streaming.
- [ ] Add a throttled consumer and a bandwidth-limited download. Measure event-loop delay and unrelated small-request latency during a large local export. Record cancellation and resource cleanup when the consumer disconnects.
- [ ] Repeat exports on long-lived connections/clients after warmup and inspect live memory trends, including heap and native buffers. Increase total row count at fixed record width and include wide-record spikes. A rising historical peak alone is not proof of a leak; evaluate sustained live-memory growth across repeated runs.
- [ ] Retain the concurrency 1/2/4 and 0/25/100-ms protocol results, clearly identifying the single-threaded simulator limit. Keep queue waiting in per-export latency and show client shutdown separately.
- [ ] For remote tests, separate database-to-Node transfer from Node-to-user download. ZIP runs in Node and does not itself compress the database transfer.

Proposed regression policy: investigate a repeatable median slowdown above 10% or a repeatable peak-RSS increase above 20% against the same path and setup. Repeat affected cases to distinguish noise, then fix or explicitly justify the tradeoff. These are review thresholds, not advertised performance guarantees. Correctness, cleanup and query-count regressions block release regardless of speed.

Done when the candidate has reproducible comparisons and documented behavior under slow consumption. Do not require ExportLite to beat every alternative on every dataset, and do not advertise a universal RAM ceiling.

## Stage T Qualify live Turso support

Continue local protocol tests until a live test endpoint is explicitly authorized. This plan does not authorize provisioning, credentials discovery or writes to an existing remote database. When access is available, use an authorized disposable fixture database and keep secrets outside reports and source.

- [ ] Run direct and Drizzle exports against the actual target service and verify generated recursive batching SQL, query fallbacks, Unicode, JSON modes, empty results, wide records and output digests.
- [ ] Trace healthy exports to confirm one data request with one SQL statement and no metadata preflights. Verify retained session reuse and successful awaited shutdown.
- [ ] Exercise real idle expiry, slow consumers, disconnects and network interruption. Verify bounded expiry recovery before output, no replay after partial output and documented cleanup behavior when a server cannot be reached.
- [ ] Validate ordinary SDK queries alongside exports, independent clients, queue cancellation and the separation from caller transactions. Check provider request-duration and response limits against intended export sizes.
- [ ] Record service/version information where available, endpoint configuration, reproducible cases and unsupported capabilities. Keep absolute cloud performance claims tied to that environment.

Done when evidence supports each advertised remote guarantee and any remaining limitation is visible in the support matrix. If this gate is incomplete, retain the experimental label; release local support independently.

## Stage 5 Pilot integrations and concise documentation

- [ ] Complete one native SQLite download integration and one Drizzle integration in real Node applications using the packed candidate. Cover a filtered export as well as an eligible batched table.
- [ ] Verify headers, authenticated query construction, request cancellation, error logging, result statistics and correct connection lifetime. Observe at least one deliberately interrupted download and repeated successful exports.
- [ ] Provide short examples for a file, JSON Response, ZIP download and Drizzle selection. Add Turso startup/shutdown and shared-versus-separate client examples with the current support label.
- [ ] Explain late stream failures, partial caller-owned output, non-atomic file visibility, read snapshots/WAL considerations and the distinction between bytes written and bytes received by an HTTP client.
- [ ] Provide one typed HTTP contract example without promising automatic tRPC integration. Explain that client response.json() still materializes the full body. Keep framework wrappers and ordinary HTTP compression outside the core.
- [ ] Shorten the README to installation, supported drivers, common usage and contracts. Put advanced options and the canonical performance overview in linked documentation; preserve historical experiments as evidence rather than the primary guide.

Done when both integrations work from the published-style artifact and feedback identifies no unresolved release-blocking issue in a supported flow. Add a small API feature only if a pilot demonstrates the existing path is inadequate.

## Stage 6 Release and maintain

- [ ] Verify npm name availability and package ownership, then finish repository metadata, MIT license verification, issue reporting, changelog, support policy and the reproducible release workflow. Keep private enabled until publication is deliberately performed.
- [ ] Publish 1.0.0-rc.1 for limited early use, then 1.0.0 when the release gate passes. Resolve supported-path correctness, lifecycle and installation blockers before tagging the stable version.
- [ ] Release the exact tested tarball/build with a changelog and benchmark reference. Identify stable local/Drizzle support and Turso's qualification status explicitly.
- [ ] For later patches, run affected tests plus the compatibility smoke suite. Rerun performance comparisons when changes affect SQL generation, buffering, compression or transport. Check current dependency releases before upgrades and widen support only after verification.

The stable-release gate is: supported contracts documented; no unresolved supported-path correctness or resource-cleanup blocker; compatibility and clean installs passing; candidate performance evidence complete; pilots passing; and remote support claims no broader than completed live verification.

## Backlog after the initial stable release

1. Investigate a deliberately restricted batched path for filtered table exports. Keep one export statement, ordering, bindings, snapshot consistency and cancellation. Continue using the current fallback for unsupported query shapes.
2. Consider declaring a direct batching key independently of output columns, matching the flexibility already available through Drizzle schemas.
3. Consider a direct stored-JSON column mode and a configurable ZIP entry name when integrations need them.
4. Add narrowly defined SQL-based timestamp representations only with correct JSON wire types and a demonstrated need. Preserve explicit rejection of arbitrary JS decoders.

Any larger feature needs measured demand and its own acceptance criteria. The first stable release should remain a focused SQLite export package.

## Workspace evidence

These references are relative to the local exportlite directory; their existence does not imply the corresponding future release gate is complete.

- README.md and src/ for the current API and implementation.
- benchmarks/DRIZZLE-ADAPTER.md for local adapter and query-fallback comparisons.
- benchmarks/TURSO-SESSIONS.md for session reuse, request counts and local latency measurements.
- benchmarks/TURSO-CONCURRENCY.md for the shared/separate-client comparison and simulator limits.
- ../outputs/performance-current/summary.json for the matched three-way plain JSON comparison.
- ../outputs/performance-zip/summary.json for the three-way ZIP comparison before memLevel 9 tuning.
- ../outputs/zip-memlevel-9/summary.json for the later compression-setting comparison.
- ../outputs/turso-concurrency/comparison/validation.json and ../outputs/turso-session-reuse/checks.json for recorded benchmark and verification evidence.
