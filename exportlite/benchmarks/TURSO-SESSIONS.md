# Reusable Turso export sessions: implementation and latency benchmark

Measured October 18, 2026, on the same Apple M1 Pro / 32 GiB machine, exact Node **26.12.0** executable (verified binary SHA-256), original varied fixture database files (verified SHA-256), SQLite **3.53.4**, `@libsql/client` **0.18.0**, Drizzle **0.45.4**, and `better-sqlite3` **13.0.3**. Current npm versions were checked and the pinned versions retained.

## Result and API behavior

Each client retains one healthy export session. Direct and Drizzle exports on that client serialize when consumption starts, including output completion and cleanup. Each healthy export sends one cursor request containing one SQL SELECT, with no schema or capability preflight. Successful exports keep only the latest baton and base URL. The session is separate from ordinary SDK/Drizzle queries and their transactions; each export reads a fresh snapshot. Fixed 256-row batching, row fallbacks, 64 KiB buffering and ZIP settings are unchanged.

Use **`await client.close()`** to abort active/queued exports, wait for output and cursor cleanup, and close the retained session. Close is idempotent and reports remote cleanup failure; a completed export and its valid file are unaffected by a later shutdown failure. `await client.reconnect()` drains the old export lifecycle before opening a fresh one. A slow export blocks subsequent exports on that client; different clients remain independent.

Cancelled/failed exports discard their session before the queue advances. Expiry recovery makes at most one fresh request after a cached baton is rejected with HTTP 404 or legacy HTTP 400 / `STREAM_EXPIRED`, before a cursor header or row is accepted. Other HTTP errors, network failures, SQL errors and partial streams are never replayed. An expired close is treated as already closed. The modern `replication_index` cursor terminator is accepted alongside legacy cursor framing.

## Timing boundary and shutdown cost

**Export times include complete UTF-8 output; client shutdown is measured separately.** This is the intended client-lifetime change: the old implementation awaited close after each export, while the new implementation awaits it at client shutdown. Every worker explicitly awaits shutdown, verifies zero remaining sessions, and records `shutdownMs`. Creating and closing a client for every export still pays a query round trip plus a close round trip. Reuse benefits a client that outlives an individual export.

All four methods were rerun at **0, 25 and 100 ms added latency per HTTP request**, never per row or SQLite batch. Ordinary Turso/Drizzle execution still combines execute and close in one pipeline request. There is no compression, TLS, bandwidth cap, jitter or packet loss in this local HTTP simulation.

## Bulk comparison

Times are medians of three fresh-worker medians; each bulk worker verifies bytes, warms once, then measures three complete exports. RSS is the whole client-process high-water mark, including imports, verification, warmup, timed requests and shutdown. It excludes the database server and coordinator. Memory columns use the 100 ms workers; the CSV contains every latency's memory measurements.

### 1,000,000 narrow rows

| Method | 0 ms: export ms | 25 ms: export ms | 100 ms: export ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct ExportLite/Turso | 645.61 | 675.03 | 741.89 | 738.34–745.23 | 138.8 | 139.9 |
| ExportLite Drizzle adapter | 641.79 | 666.23 | 747.14 | 741.94–753.18 | 225.8 | 229.2 |
| Turso execute + stringify | 5161.07 | 5111.14 | 5177.39 | 5155.87–5272.12 | 1901.2 | 1901.9 |
| Drizzle all + stringify | 5413.61 | 5586.01 | 5526.48 | 5425.48–5637.95 | 1901.0 | 2012.6 |

### 100,000 wide rows

| Method | 0 ms: export ms | 25 ms: export ms | 100 ms: export ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct ExportLite/Turso | 564.53 | 557.32 | 643.55 | 639.31–657.43 | 229.5 | 239.1 |
| ExportLite Drizzle adapter | 561.82 | 557.25 | 635.20 | 635.01–640.13 | 291.6 | 297.6 |
| Turso execute + stringify | 1273.05 | 1321.68 | 1376.57 | 1359.62–1396.02 | 1508.9 | 1564.9 |
| Drizzle all + stringify | 1316.30 | 1368.90 | 1404.33 | 1392.89–1565.76 | 1546.8 | 1572.9 |

## Change from closing after each export

The previous numbers are the preceding matched benchmark, not a concurrent rerun of the old implementation. The comparison therefore includes ordinary run-to-run variation. A 100 ms reduction is the expected structural benefit of removing one close round trip from each successful export; the measured delta need not equal it exactly.

| Fixture | ExportLite API | Previous 100 ms total, ms | Reuse 100 ms export, ms | Saved, ms | Previous highest RSS, MiB | Reuse highest RSS, MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| table-1 | Direct ExportLite/Turso | 206.14 | 107.59 | 98.55 | 95.9 | 96.0 |
| table-1 | ExportLite Drizzle adapter | 208.69 | 107.73 | 100.96 | 212.9 | 212.6 |
| table-10 | Direct ExportLite/Turso | 210.09 | 107.02 | 103.07 | 96.6 | 95.7 |
| table-10 | ExportLite Drizzle adapter | 209.57 | 107.05 | 102.52 | 212.3 | 212.8 |
| table-1000 | Direct ExportLite/Turso | 211.03 | 107.97 | 103.05 | 103.0 | 101.7 |
| table-1000 | ExportLite Drizzle adapter | 211.08 | 108.28 | 102.80 | 212.3 | 212.6 |
| narrow-plain | Direct ExportLite/Turso | 859.63 | 741.89 | 117.74 | 142.8 | 139.9 |
| narrow-plain | ExportLite Drizzle adapter | 851.52 | 747.14 | 104.38 | 243.5 | 229.2 |
| wide-plain | Direct ExportLite/Turso | 754.06 | 643.55 | 110.51 | 234.1 | 239.1 |
| wide-plain | ExportLite Drizzle adapter | 745.54 | 635.20 | 110.34 | 304.0 | 297.6 |

### Client shutdown at 100 ms added latency

One explicit close request per ExportLite worker/client, outside export timing. A bulk client performs five exports total (verification, warmup and three measured exports); a small client performs eleven. Closing a client per request would add this cost back to the response lifecycle.

| Fixture | API | Median awaited client close, ms |
| --- | --- | ---: |
| table-1 | Direct ExportLite/Turso | 106.27 |
| table-1 | ExportLite Drizzle adapter | 107.52 |
| narrow-plain | Direct ExportLite/Turso | 103.34 |
| narrow-plain | ExportLite Drizzle adapter | 103.23 |
| wide-plain | Direct ExportLite/Turso | 104.48 |
| wide-plain | ExportLite Drizzle adapter | 103.18 |

## Small responses

Each worker measures three samples of three requests after byte verification and one warmup. As in the prior comparison, small outputs consume `Response.arrayBuffer()`; bulk outputs drain to the same counting Node writable.

| Fixture | Method | 0 ms: export ms | 25 ms: export ms | 100 ms: export ms | Highest RSS at 100 ms, MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| table-1 | Direct ExportLite/Turso | 1.66 | 28.14 | 107.59 | 96.0 |
| table-1 | ExportLite Drizzle adapter | 1.63 | 28.19 | 107.73 | 212.6 |
| table-1 | Turso execute + stringify | 1.44 | 27.93 | 106.51 | 95.2 |
| table-1 | Drizzle all + stringify | 1.39 | 27.87 | 106.81 | 222.0 |
| table-10 | Direct ExportLite/Turso | 1.66 | 28.26 | 107.02 | 95.7 |
| table-10 | ExportLite Drizzle adapter | 1.65 | 28.26 | 107.05 | 212.8 |
| table-10 | Turso execute + stringify | 1.35 | 27.76 | 106.98 | 95.3 |
| table-10 | Drizzle all + stringify | 1.52 | 27.95 | 106.78 | 221.7 |
| table-1000 | Direct ExportLite/Turso | 2.95 | 29.07 | 107.97 | 101.7 |
| table-1000 | ExportLite Drizzle adapter | 2.51 | 29.06 | 108.28 | 212.6 |
| table-1000 | Turso execute + stringify | 5.82 | 31.99 | 112.39 | 104.0 |
| table-1000 | Drizzle all + stringify | 6.49 | 32.87 | 112.40 | 221.7 |

## Validation and limits

- **180 sequential fresh workers**, three per fixture/method/latency combination, with rotated method order; **1188 timed exports**. A 16-worker smoke run passed first.
- All worker output lengths and SHA-256 hashes match the original fixtures and all four methods. Narrow JSON is 83,369,847 bytes; wide JSON is 100,920,480 bytes. Timed exports check lengths and ExportLite row counts. Fixture and package source/build fingerprints match before and after timing.
- Traces verify exactly one SQL statement and cursor request per healthy ExportLite export, no preflights, one opened session per client, baton rotation/reuse, at most one retained session, one close request per client and zero sessions after awaited shutdown. Ordinary queries retain their one execute-plus-close pipeline request per export.
- In the CSV, `exportHttpRequests` counts data requests only (one per export). `httpRequests` includes the amortized client-shutdown request: 12/11 for small ExportLite workers and 6/5 for bulk workers. Shutdown has not been eliminated; it has moved to client lifetime and is timed separately.
- **363 reliability tests pass on Node 26.12.0**, including serialized direct/Drizzle exports, queued cancellation, no queued-file creation, stalled outputs, independent clients, legacy/modern expiry, bounded recovery, no replay after HTTP/network/SQL/partial-stream failures, awaited/idempotent close, active/idle shutdown failures, reconnect and preservation of completed files. ESM/CommonJS builds, public consumer types and Biome checks pass.
- Whole-process peak RSS includes SDK and optional Drizzle imports, setup and natural GC. No forced collection or artificial retained row arrays. The direct SDK baseline stringifies `result.rows`; normal Drizzle builds an ordered select, awaits `.all()` and stringifies its objects. Imported Drizzle runtime contributes to adapter process memory.
- The local server uses actual read-only SQLite and official JSON protocol framing, incrementally coalesced to 64 KiB, with the same 120-second HTTP keep-alive timeout as the preceding completed comparison. Its JavaScript serialization cost affects wall time. The published libSQL server buffers ordinary pipeline results before sending; the fixture streams those bodies, so server memory, response scheduling and time to first byte are not faithfully simulated. See [reference server source](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/hrana/http/mod.rs).
- These are local protocol measurements, not verified Turso Cloud gains. Actual network bandwidth, TLS, server implementations, response limits, cold starts and concurrent load remain unmeasured. Idle-expiry recovery and queue contention are tested for correctness but are outside the sequential healthy-session timing matrix. Live Turso compatibility remains unverified.
- Queueing changes concurrency: one slow consumer can delay other exports on that client. A client kept idle can lose its cached session and incur one failed request on recovery. Shutdown must be awaited when confirmed cleanup matters; on an unreachable server, expiry remains the final resource cleanup fallback.

## Reproduce

Use the exact Node executable recorded in configuration.json, from the workspace root:

```sh
/path/to/node-26.12.0 outputs/turso-session-reuse/run.mjs
/path/to/node-26.12.0 outputs/turso-session-reuse/report.mjs
```

Localhost binding permission is required. Add `--smoke` for the short run. No live credentials or cloud resources are used.

- [Summary CSV](../../outputs/turso-session-reuse/comparison/summary.csv)
- [Worker measurements and HTTP traces](../../outputs/turso-session-reuse/comparison/all.json)
- [Configuration, versions and fingerprints](../../outputs/turso-session-reuse/comparison/configuration.json)
- [Validation](../../outputs/turso-session-reuse/comparison/validation.json)
- [Previous per-export close benchmark](TURSO.md)
- [Runner](../../outputs/turso-session-reuse/run.mjs), [worker](../../outputs/turso-session-reuse/worker.mjs), [server](../../outputs/turso-session-reuse/server.mjs)
