# Concurrent Turso exports: shared versus separate clients

Measured 2026-10-18 with the existing ExportLite session-reuse implementation. This changes the benchmark only. Package source, compiled output, dependency lockfile, fixture databases and exact Node binary match the preceding session-reuse run.

At 100 ms added latency, four separate clients improve direct-API throughput by **3.85× for 1,000 rows, 1.12× for 1M narrow rows and 1.18× for 100K wide rows** versus one shared client. The shared session queue exposes network wait for each export in succession. Separate clients overlap that wait; large exports still share this simulator's single-threaded generation capacity. These are local measurements, not a Turso Cloud scaling result.

## Four simultaneous exports, 100 ms added latency

Each wave submits four exports at once. **Shared** uses one reusable client/session and its existing export queue; **separate** uses four clients/sessions in the same client process against the same server/database. Clients persist across warmup and timed waves. Throughput is exports completed per second of wave wall time. Latency includes queue wait and full output consumption.

Rates are medians of three fresh workers. Mean and p95 latency pool all 24 timed exports per row (six waves). Peak memory is the **highest whole-client-process RSS observed across those workers**, including imports, verification/warmup, simultaneous streams, natural GC and shutdown; database server and coordinator are separate processes and excluded. MiB = 2^20 bytes.

| Fixture | API | Clients | Exports/s | Mean export ms | p95 export ms | Peak RSS MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1 row | Direct | shared | 9.56 | 265.2 | 433.5 | 96.0 |
| 1 row | Direct | separate | 37.65 | 106.0 | 110.6 | 96.2 |
| 1 row | Drizzle adapter | shared | 9.48 | 264.3 | 426.2 | 208.8 |
| 1 row | Drizzle adapter | separate | 37.64 | 105.5 | 106.5 | 222.1 |
| 10 rows | Direct | shared | 9.52 | 265.8 | 430.2 | 96.0 |
| 10 rows | Direct | separate | 37.50 | 106.0 | 106.9 | 96.8 |
| 10 rows | Drizzle adapter | shared | 9.62 | 264.0 | 434.8 | 208.2 |
| 10 rows | Drizzle adapter | separate | 37.51 | 105.8 | 106.9 | 205.9 |
| 1,000 rows | Direct | shared | 9.46 | 265.1 | 427.9 | 101.9 |
| 1,000 rows | Direct | separate | 36.42 | 111.8 | 133.7 | 101.8 |
| 1,000 rows | Drizzle adapter | shared | 9.39 | 266.8 | 429.7 | 208.0 |
| 1,000 rows | Drizzle adapter | separate | 36.79 | 107.4 | 111.3 | 209.4 |
| 1M narrow | Direct | shared | 1.35 | 1907.0 | 3239.5 | 180.2 |
| 1M narrow | Direct | separate | 1.51 | 1712.5 | 2705.2 | 182.6 |
| 1M narrow | Drizzle adapter | shared | 1.35 | 1866.1 | 3011.1 | 234.2 |
| 1M narrow | Drizzle adapter | separate | 1.50 | 1713.9 | 2695.0 | 231.1 |
| 100K wide | Direct | shared | 1.49 | 1660.7 | 2690.8 | 251.9 |
| 100K wide | Direct | separate | 1.76 | 1459.5 | 2277.9 | 261.5 |
| 100K wide | Drizzle adapter | shared | 1.57 | 1632.4 | 2701.1 | 311.9 |
| 100K wide | Drizzle adapter | separate | 1.79 | 1512.5 | 2347.2 | 310.3 |

### Separate/shared ratios at concurrency four, 100 ms

Throughput above 1 is better. Latency below 1 is better. Memory is separate minus shared, using the highest measured RSS for each setting.

| Fixture | API | Throughput ratio | Mean latency ratio | Peak RSS difference MiB |
| --- | --- | ---: | ---: | ---: |
| 1 row | Direct | 3.94× | 0.40× | 0.2 |
| 1 row | Drizzle adapter | 3.97× | 0.40× | 13.3 |
| 10 rows | Direct | 3.94× | 0.40× | 0.8 |
| 10 rows | Drizzle adapter | 3.90× | 0.40× | -2.3 |
| 1,000 rows | Direct | 3.85× | 0.42× | -0.0 |
| 1,000 rows | Drizzle adapter | 3.92× | 0.40× | 1.4 |
| 1M narrow | Direct | 1.12× | 0.90× | 2.5 |
| 1M narrow | Drizzle adapter | 1.11× | 0.92× | -3.1 |
| 100K wide | Direct | 1.18× | 0.88× | 9.6 |
| 100K wide | Drizzle adapter | 1.14× | 0.93× | -1.5 |

## Scaling and latency sensitivity

Direct API exports/s. Concurrency one is a common single-client control, since both policies are identical there. The complete direct/Drizzle matrix, latency statistics, worker ranges and both median/highest memory are in the [summary CSV](../../outputs/turso-concurrency/comparison/summary.csv).

| Fixture | Added latency ms | C1 | C2 shared | C2 separate | C4 shared | C4 separate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 row | 0 | 389.43 | 523.33 | 659.42 | 635.70 | 938.99 |
| 1 row | 25 | 34.67 | 35.06 | 67.79 | 35.61 | 129.46 |
| 1 row | 100 | 9.59 | 9.56 | 19.12 | 9.56 | 37.65 |
| 10 rows | 0 | 390.56 | 498.33 | 665.96 | 603.60 | 874.74 |
| 10 rows | 25 | 34.44 | 35.41 | 66.53 | 35.48 | 129.02 |
| 10 rows | 100 | 9.56 | 9.39 | 19.10 | 9.52 | 37.50 |
| 1,000 rows | 0 | 264.89 | 344.60 | 400.97 | 388.80 | 518.43 |
| 1,000 rows | 25 | 33.11 | 33.96 | 63.36 | 34.29 | 119.48 |
| 1,000 rows | 100 | 9.53 | 9.54 | 18.70 | 9.46 | 36.42 |
| 1M narrow | 0 | 1.53 | 1.54 | 1.54 | 1.55 | 1.56 |
| 1M narrow | 25 | 1.48 | 1.48 | 1.50 | 1.36 | 1.54 |
| 1M narrow | 100 | 1.34 | 1.34 | 1.43 | 1.35 | 1.51 |
| 100K wide | 0 | 1.86 | 1.74 | 1.79 | 1.73 | 1.77 |
| 100K wide | 25 | 1.76 | 1.76 | 1.81 | 1.77 | 1.83 |
| 100K wide | 100 | 1.55 | 1.56 | 1.71 | 1.49 | 1.76 |

## Method and validation

- Exact Node **26.12.0**, binary SHA-256 `12ccc7c7d8b9b33ac0740fc7c2590d2aba14ccfa0a40f3d3f7a6c4c60c87f07c`; SQLite **3.53.4**, better-sqlite3 **13.0.3**, @libsql/client **0.18.0**, Drizzle **0.45.4**. Latest npm metadata was checked on October 18; matched versions were retained. Hardware: Apple M1 Pro, 32 GiB RAM.
- The same five varied fixtures as [the previous comparison](TURSO-SESSIONS.md): 1, 10 and 1,000 rows; 1,000,000 narrow rows producing 83,369,847 bytes (79.51 MiB); 100,000 wide rows producing 100,920,480 bytes (96.25 MiB). Original fixture database/output hashes are recorded in configuration.
- **450 fresh client workers**, run sequentially with rotated policy/API order. Three workers per fixture/API/latency/setting. Each runs a full-concurrency verification wave that warms every client/session, then two timed waves: **2340 timed exports**, plus **1170 hash-verified warmup exports**. Every export checks byte length and exported row count; each lane's verification checks its entire output SHA-256.
- Each worker has one fresh separate HTTP/SQLite server process. Shared and separate clients both use that one endpoint and database. The server is copied from the preceding benchmark with request-start/end and maximum-overlap counters added; its data path is unchanged. No extra servers or database CPU are allocated to the separate policy.
- Server traces assert one SQL SELECT and one cursor HTTP request per export, fixed 256-row batches, no preflight queries, one opened/reused session per client, shared-client maximum overlap of one, full separate-client overlap at 100 ms, one close request per client and zero sessions after awaited shutdown. Package/build/harness and fixture fingerprints match before/after. No package implementation edits were made.
- Latency is fixed at 0, 25 or 100 ms once per HTTP request before response; it is never applied per SQLite batch or row. Healthy cached sessions are reused, with no simulated expiry/failure in the timed matrix.
- Per-export timers start at submission before the client queue can be acquired, and stop after all bytes are consumed. Small outputs use the existing Web stream plus Response.arrayBuffer; bulk drains to the same counting Node writable with immediate callbacks. Imports, client/schema/Drizzle initialization and server startup are excluded from timing. Default 256-row batching and 64 KiB buffering are unchanged.
- Client close is awaited concurrently after all waves and excluded from export times. Separate clients each send one close request, while a shared client sends one. Shutdown time and memory are recorded. No forced GC, compression, output files, application HTTP download, TLS, jitter, loss or bandwidth cap.

## Interpretation limits

These are **burst waves**, not a continuous-load capacity test: each wave waits for its slowest export before starting the next. The shared queue completes work successively; separate clients overlap their requests but compete for resources. A throughput gain does not guarantee lower individual latency under contention. p95 is a descriptive nearest-rank sample statistic (24 requests at C4, 12 at C2, six at C1), not a production tail-latency estimate.

The fixture server runs real read-only SQLite and JSON protocol framing on **one JavaScript event loop and one native SQLite connection**. At zero added latency, traces show some large separate-client responses are served successively; at nonzero latency the request waits overlap. Synchronous SQLite generation and protocol serialization share that server's CPU capacity. The client also has one event loop for all streams. This limits large-export parallelism; different Turso server hardware, concurrency scheduling and actual network bandwidth can produce different results. No live Turso Cloud performance or compatibility has been verified. Peak RSS is process-level high-water usage with natural GC; it is not a per-stream allocation estimate or a guaranteed memory ceiling. Drizzle runtime imports contribute to its process baseline.

Only homogeneous fast-consumer waves were measured. Mixed export sizes, slow destinations, long-running continuous arrivals, session expiry and cancellation remain outside this timing matrix. Existing backpressure, cancellation and cleanup code is unchanged.

## Reproduce and artifacts

Run from the workspace root with the exact Node binary recorded in configuration (localhost binding permission required). Existing result directories are protected from overwrite.

```sh
/path/to/node-26.12.0 outputs/turso-concurrency/run.mjs
/path/to/node-26.12.0 outputs/turso-concurrency/report.mjs
```

To repeat a run, rename the existing comparison/ directory first; measurements are never overwritten. Add --smoke for the 18-worker validation matrix, and to report.mjs to summarize that run separately (rename smoke/ first when repeating it).

- [Summary CSV](../../outputs/turso-concurrency/comparison/summary.csv), [summary JSON](../../outputs/turso-concurrency/comparison/summary.json)
- [Raw workers and request traces](../../outputs/turso-concurrency/comparison/all.json)
- [Configuration and fingerprints](../../outputs/turso-concurrency/comparison/configuration.json), [validation](../../outputs/turso-concurrency/comparison/validation.json), [matched-runtime/package evidence](../../outputs/turso-concurrency/compatibility.json)
- [Runner](../../outputs/turso-concurrency/run.mjs), [worker](../../outputs/turso-concurrency/worker.mjs), [server](../../outputs/turso-concurrency/server.mjs), [report generator](../../outputs/turso-concurrency/report.mjs)
