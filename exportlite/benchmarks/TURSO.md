# Turso and Drizzle: simulated latency comparison

Measured October 18, 2026, using the exact prior Node **26.12.0** executable and original varied fixture files. Pinned versions, also checked against current npm metadata: **@libsql/client 0.18.0**, **Drizzle 0.45.4**, **better-sqlite3 13.0.3**, SQLite **3.53.4**. Host: Apple M1 Pro, 32 GiB RAM.

This is a local HTTP protocol simulation, not a live Turso Cloud benchmark. It includes actual official-client and Drizzle execution, SQLite work in a separate server process, protocol serialization/decoding, JSON generation, UTF-8 output and awaited export cleanup. It measures uncompressed JSON.

## Bulk exports

Times are the median of three fresh-client-worker medians, with three measured complete exports per worker after verification and one warmup. Every worker has its own separate fresh HTTP/SQLite server process. Peak RSS is the whole client-process high-water mark, including imports, setup, verification, warmup and timed requests; it excludes the coordinator and database server. Memory columns below use the 100 ms latency workers. No forced garbage collection.

### 1,000,000 narrow rows

| Method | 0 ms latency: total ms | 25 ms latency: total ms | 100 ms latency: total ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct ExportLite/Turso | 656.07 | 698.37 | 859.63 | 848.56–862.06 | 140.8 | 142.8 |
| ExportLite Drizzle adapter | 655.50 | 695.89 | 851.52 | 850.44–852.60 | 232.3 | 243.5 |
| Turso execute + stringify | 5205.63 | 5310.41 | 5238.29 | 5207.21–5268.77 | 2001.8 | 2157.9 |
| Drizzle all + stringify | 5549.34 | 5569.43 | 5631.69 | 5606.29–5801.66 | 2009.0 | 2026.7 |

Direct ExportLite is **6.09× faster** than its ordinary query-plus-stringify counterpart at 100 ms added latency, with **93.4% lower highest observed client RSS**.

The Drizzle adapter is **6.61× faster** than its ordinary query-plus-stringify counterpart at 100 ms added latency, with **88.0% lower highest observed client RSS**.

### 100,000 wide rows

| Method | 0 ms latency: total ms | 25 ms latency: total ms | 100 ms latency: total ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct ExportLite/Turso | 536.24 | 594.28 | 754.06 | 746.94–755.33 | 222.6 | 234.1 |
| ExportLite Drizzle adapter | 531.84 | 599.85 | 745.54 | 744.19–757.85 | 303.1 | 304.0 |
| Turso execute + stringify | 1260.79 | 1303.39 | 1374.34 | 1369.40–1499.09 | 1495.8 | 1510.1 |
| Drizzle all + stringify | 1330.88 | 1369.13 | 1415.10 | 1400.86–1754.41 | 1497.5 | 1507.7 |

Direct ExportLite is **1.82× faster** than its ordinary query-plus-stringify counterpart at 100 ms added latency, with **84.5% lower highest observed client RSS**.

The Drizzle adapter is **1.90× faster** than its ordinary query-plus-stringify counterpart at 100 ms added latency, with **79.8% lower highest observed client RSS**.

### Peak client RSS at every latency

Highest observed process high-water mark across the three workers, in MiB. The CSV also includes median and minimum worker peaks.

| Fixture | Method | 0 ms latency | 25 ms latency | 100 ms latency |
| --- | --- | ---: | ---: | ---: |
| narrow-plain | Direct ExportLite/Turso | 141.7 | 144.3 | 142.8 |
| narrow-plain | ExportLite Drizzle adapter | 223.6 | 219.0 | 243.5 |
| narrow-plain | Turso execute + stringify | 2015.4 | 2009.6 | 2157.9 |
| narrow-plain | Drizzle all + stringify | 1977.1 | 1979.8 | 2026.7 |
| wide-plain | Direct ExportLite/Turso | 232.6 | 249.4 | 234.1 |
| wide-plain | ExportLite Drizzle adapter | 315.2 | 305.3 | 304.0 |
| wide-plain | Turso execute + stringify | 1574.2 | 1508.0 | 1510.1 |
| wide-plain | Drizzle all + stringify | 1530.5 | 1700.3 | 1507.7 |

## Small responses and the extra round trip

Added latency is applied **once per HTTP request**, never per row or SQLite batch. It models fixed request/response delay; there is no bandwidth cap, TLS, jitter or packet loss. Each ExportLite export uses one cursor request followed by one close request. Ordinary SDK/Drizzle execution combines execute and close in one pipeline request. All paths execute exactly one SQL statement and issue no preflight SQL. ExportLite completion includes the close request.

| Fixture | Method | 0 ms latency: total ms | 25 ms latency: total ms | 100 ms latency: total ms | Highest RSS at 100 ms, MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 row | Direct ExportLite/Turso | 1.93 | 56.03 | 206.14 | 95.9 |
| 1 row | ExportLite Drizzle adapter | 1.88 | 58.48 | 208.69 | 212.9 |
| 1 row | Turso execute + stringify | 1.59 | 27.42 | 106.89 | 95.1 |
| 1 row | Drizzle all + stringify | 1.42 | 27.91 | 104.46 | 206.3 |
| 10 rows | Direct ExportLite/Turso | 2.21 | 56.14 | 210.09 | 96.6 |
| 10 rows | ExportLite Drizzle adapter | 2.10 | 55.76 | 209.57 | 212.3 |
| 10 rows | Turso execute + stringify | 1.51 | 28.06 | 106.53 | 95.0 |
| 10 rows | Drizzle all + stringify | 1.60 | 28.51 | 105.31 | 204.0 |
| 1,000 rows | Direct ExportLite/Turso | 3.61 | 61.39 | 211.03 | 103.0 |
| 1,000 rows | ExportLite Drizzle adapter | 2.97 | 59.57 | 211.08 | 212.3 |
| 1,000 rows | Turso execute + stringify | 6.31 | 32.17 | 111.12 | 104.2 |
| 1,000 rows | Drizzle all + stringify | 6.49 | 32.96 | 111.51 | 221.8 |

Small-response workers measure three samples of three requests each, after byte verification and one warmup. Small responses consume `Response.arrayBuffer()`; bulk outputs drain to a counting Node writable. Destinations match within every fixture. Small differences in the 0 ms runs are sensitive to HTTP scheduling and process noise.

## Response sizes and protocol overhead

All four paths produce exactly identical final JSON byte lengths and SHA-256 hashes. The response-body bytes crossing the database HTTP connection differ: normal queries encode a typed protocol value for each field, while ExportLite sends one JSON-text value plus a count per 256-row batch. Counts below include the ExportLite close response; HTTP headers and chunk framing are excluded.

| Fixture | Final JSON, MiB | ExportLite protocol bodies, MiB | Ordinary query protocol bodies, MiB |
| --- | ---: | ---: | ---: |
| narrow-plain | 79.51 | 90.99 | 152.12 |
| wide-plain | 96.25 | 98.15 | 103.51 |

These wire counts help explain the bulk advantage in this fixture server. They do not establish transfer times over a bandwidth-limited connection.

## Fairness, validation and limitations

- **180 sequential fresh client workers**, three per fixture/method/latency combination, with rotated method order; **1188 timed exports**. A separate 16-worker smoke run passed first.
- Official `@libsql/client/http` executes the ordinary Turso queries, and `drizzle-orm/libsql/http` executes the ordinary Drizzle queries. Both use their real buffering/decoding paths. Direct Turso serializes `result.rows` directly with `JSON.stringify()`; Drizzle builds an ordered select, awaits `.all()`, then stringifies the returned objects. No artificial extra row mapping or retained arrays are added.
- ExportLite benchmarks use the public table APIs, integer primary-key declarations or Drizzle metadata, fixed 256-row batching and the existing 64 KiB writer. All methods project `id, name, note, active`, in that order, ordered by integer id. Boolean fields use numeric mode to match the existing fixtures.
- Every worker validates output byte length and SHA-256; timed exports check output length and ExportLite row counts. Original fixture fingerprints match before and after the run. Package source/build fingerprints match before and after timing.
- HTTP traces verify one SQL SELECT per export, no metadata/version/capability queries, two HTTP requests for ExportLite versus one for ordinary queries, 256-row batches and no remaining server sessions.
- Client imports, schema declarations and opening SDK/Drizzle wrappers are outside request timing, but are included in peak RSS. Drizzle methods therefore include Drizzle runtime import memory. Server startup and opening the SQLite database are outside timing and client RSS. Reads are warm; these are not cold-start or cold-disk results.
- The same benchmark server writes both response formats incrementally with 64 KiB coalescing and honors socket backpressure. It does not buffer the ordinary query result in the server. Its JavaScript protocol framing and serialization can cost more than a native Turso server, particularly for one million typed rows. Total time includes that cost, so these speedup ratios must not be presented as measured Turso Cloud gains. Server traces include response bytes, CPU and request duration for inspection.
- A subsequent protocol review confirmed another simulator limitation: the published [libSQL HTTP server](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/hrana/http/mod.rs) collects pipeline results and serializes the complete response before sending it, whereas the fixture writes ordinary pipeline rows incrementally. The simulation therefore does not reproduce that server-side buffering, time to first byte or server memory. Client RSS remains directly measured for the simulated response schedule; a real server's delivery schedule could change both client timing and peak allocations. An incremental client-side pipeline parser would not restore end-to-end streaming on a buffering server. The current [Turso protocol](https://github.com/tursodatabase/turso/blob/main/serverless/PROTOCOL.md#43-stream-retention) retains cursor sessions until close or expiry and provides no close-after-cursor flag.
- The fixture server uses a 120-second keep-alive timeout for every method. An initial comparison stopped when the default five-second timeout reset a socket during a large buffered client decode. That interrupted run is excluded. A separate five-export bulk verification passed with the longer timeout before the full comparison was restarted.
- Fixed request delay does not reproduce actual TCP flow control, geography, TLS, bandwidth limits, connection setup, cloud query scheduling, serverless cold starts, response limits or concurrent load. Live Turso compatibility and remote performance remain unverified.
- Each ExportLite export is an independent read session. The simulation does not change the public API, batch size, output buffering or ZIP settings. Compression is outside this comparison.
- Benchmark setup exposed a protocol compatibility check that required an undocumented `step` field on `step_end`. The [Hrana v3 specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md) omits that field. The adapter now accepts the documented message, and the integration fixture sends it. This correction precedes all timing; the **338-test suite**, ESM/CommonJS builds, public consumer type checks and Biome checks pass. The exact change is preserved in [protocol-compatibility.patch](../../outputs/turso-benchmark/protocol-compatibility.patch).

## Reproduce and inspect

From the workspace root, use the exact Node executable recorded in configuration.json:

```sh
/path/to/node-26.12.0 outputs/turso-benchmark/run.mjs
/path/to/node-26.12.0 outputs/turso-benchmark/report.mjs
```

`--smoke` runs the shorter validation. Running requires permission to bind localhost. All database connections are read-only; no credentials or live cloud resources are used.

- [Summary CSV](../../outputs/turso-benchmark/comparison/summary.csv)
- [All worker results and server traces](../../outputs/turso-benchmark/comparison/all.json)
- [Configuration, versions, method and fingerprints](../../outputs/turso-benchmark/comparison/configuration.json)
- [Validation](../../outputs/turso-benchmark/comparison/validation.json)
- [Runner](../../outputs/turso-benchmark/run.mjs), [worker](../../outputs/turso-benchmark/worker.mjs), [server](../../outputs/turso-benchmark/server.mjs)
