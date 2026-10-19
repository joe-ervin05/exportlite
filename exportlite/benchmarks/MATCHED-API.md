# Matched JSON generation and response encoding

These historical measurements predate the [UTF-8 byte-path optimization](REMAINING-GAP.md). The preserved source and results remain available.

These measurements describe the implementation before the boundary-query optimization. See [batch profiling and tuning](BATCH-PROFILE.md) for the controlled before/after comparison.

Measured October 17, 2026. All four methods use the original fixture, Node **26.12.0**, SQLite **3.53.4**, better-sqlite3 **13.0.3**, and Drizzle **0.45.4**. These are response-production timings through UTF-8 bytes in memory, with no compression, disk or network transfer.

Completed **267 fresh workers** across all **21 original cases** and the additional controls. Every worker's complete validation output matches the original JSON SHA-256 digest. Timed response byte counts also match.

## Findings

- On the matched million-user flat fixture, full aggregation is 3.72× as fast as Drizzle; ExportLite batching is 2.32× as fast. The complete aggregate and streaming batches remain different algorithms even after matching the dataset and runtime.
- UTF-8 encoding is 0.6–1.8% of total time across the main million-root comparisons. It is not the principal explanation for their throughput differences on this ASCII fixture.
- Actual public Web-stream table export takes 217.83 ms for the same million flat users. The row-streaming producer takes 543.26 ms, versus 256.20 ms for manual all()+stringify. Streaming alone does not guarantee a speed win; the batch path matters.
- Full aggregation retains the whole response before encoding. ExportLite keeps its existing batch/writable flow and lower retained memory. Peak-RSS columns include module startup, verification and warmups, so they describe whole worker processes rather than per-request allocations.
- These changes add benchmark tooling only. Nested batching and limited-root projections are benchmark adapters around the actual planner/producer, not new public API features.

## One million root users

All times are milliseconds. Generation includes the real producer/writable coordination; encoding is the measured UTF-8 conversion. Components come from the same median-total observations, so they add to total before rounding.

### Users

1,000,000 total records; 22.89 MiB JSON.

| Method | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms | Peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full SQLite aggregate | 131.71 | 2.46 | 134.17 | 133.36–141.62 | 360.95 |
| ExportLite · 256-root batches | 211.85 | 3.74 | 215.59 | 214.03–230.11 | 217.56 |
| Manual JS + stringify | 251.87 | 4.33 | 256.20 | 243.29–258.82 | 435.89 |
| Drizzle + stringify | 496.80 | 2.87 | 499.66 | 495.76–502.74 | 611.05 |

On this shape, the full aggregate is 3.72× as fast as Drizzle and 1.91× as fast as manual JS. ExportLite batching is 2.32× as fast as Drizzle and 1.19× as fast as manual JS, and takes 60.7% more time than full aggregation.

### Users → posts

3,000,000 total records; 80.11 MiB JSON.

| Method | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms | Peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full SQLite aggregate | 1030.53 | 13.86 | 1044.40 | 1035.63–1047.08 | 680.58 |
| ExportLite · 256-root batches | 1120.73 | 11.46 | 1132.19 | 1130.88–1136.81 | 221.20 |
| Manual JS + stringify | 1640.33 | 16.48 | 1656.81 | 1655.36–1671.14 | 1122.27 |
| Drizzle + stringify | 2484.21 | 17.86 | 2502.07 | 2468.79–2507.68 | 937.88 |

On this shape, the full aggregate is 2.40× as fast as Drizzle and 1.59× as fast as manual JS. ExportLite batching is 2.21× as fast as Drizzle and 1.46× as fast as manual JS, and takes 8.4% more time than full aggregation.

### Users → posts → comments

7,000,000 total records; 207.90 MiB JSON.

| Method | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms | Peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full SQLite aggregate | 2954.14 | 24.69 | 2978.83 | 2976.39–3019.41 | 1362.59 |
| ExportLite · 256-root batches | 3112.92 | 28.31 | 3141.24 | 3074.69–3332.13 | 221.81 |
| Manual JS + stringify | 5319.99 | 77.27 | 5397.26 | 5293.88–5521.83 | 2648.08 |
| Drizzle + stringify | 6372.81 | 108.17 | 6480.98 | 6416.20–6560.72 | 1855.33 |

On this shape, the full aggregate is 2.18× as fast as Drizzle and 1.81× as fast as manual JS. ExportLite batching is 2.06× as fast as Drizzle and 1.72× as fast as manual JS, and takes 5.5% more time than full aggregation.

## Public API and fallback controls

| Shape at 1m roots | Control | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Users | ExportLite · row fallback | 539.75 | 3.50 | 543.26 | 522.31–547.45 |
| Users | Public table → Node writable | 212.57 | 3.73 | 216.31 | 215.02–222.66 |
| Users | Public table → Web stream | — | — | 217.83 | 216.93–221.35 |
| Users → posts | ExportLite · row fallback | 1452.49 | 12.69 | 1465.18 | 1461.01–1478.86 |
| Users → posts → comments | ExportLite · row fallback | 3413.51 | 31.14 | 3444.64 | 3442.88–3454.74 |

The public controls include validation/planning. The Web stream control is total-only; native stream conversion cannot be separated with this string-sink instrument. Nested cases use a benchmark-only projection adapter around the existing planner/producer. They do not claim public nested-query support.

## Original chart versus this run

| 1m-root shape | Original full SQLite generation ms | Current full SQLite generation/pipeline ms | Original Drizzle/SQLite ratio | Current Drizzle/SQLite total ratio | Current Drizzle/ExportLite total ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Users | 131.45 | 131.71 | 3.56× | 3.72× | 2.32× |
| Users → posts | 1023.93 | 1030.53 | 2.44× | 2.40× | 2.21× |
| Users → posts → comments | 2972.11 | 2954.14 | 2.28× | 2.18× | 2.06× |

This keeps runtime, fixture values, selected fields, relationships, ordering and baseline implementations matched. The original chart stopped at a JavaScript JSON string; this run additionally allocates UTF-8 response bytes. The current complete-aggregate baseline and the streaming exporter remain different algorithms. Phase timing is an accounting split within the full response pipeline; allocations and GC can affect later phases.

## All 21 cases

Times are `generation/pipeline + UTF-8 = total` in milliseconds. All four methods produce the same bytes within each case.

| Roots | Shape | Full SQLite | ExportLite batches | Manual JS | Drizzle |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Users | 0.0158 + 0.0007 = **0.0165** | 0.0178 + 0.0006 = **0.0184** | 0.0120 + 0.0006 = **0.0126** | 0.0112 + 0.0006 = **0.0117** |
| 1 | Users → posts | 0.0246 + 0.0007 = **0.0253** | 0.0190 + 0.0006 = **0.0196** | 0.0259 + 0.0007 = **0.0266** | 0.0233 + 0.0007 = **0.0240** |
| 1 | Users → posts → comments | 0.0336 + 0.0008 = **0.0344** | 0.0205 + 0.0007 = **0.0212** | 0.0332 + 0.0008 = **0.0340** | 0.0358 + 0.0008 = **0.0365** |
| 10 | Users | 0.0185 + 0.0008 = **0.0193** | 0.0207 + 0.0007 = **0.0214** | 0.0145 + 0.0006 = **0.0151** | 0.0150 + 0.0006 = **0.0156** |
| 10 | Users → posts | 0.0342 + 0.0010 = **0.0352** | 0.0292 + 0.0007 = **0.0299** | 0.0353 + 0.0008 = **0.0362** | 0.0421 + 0.0008 = **0.0429** |
| 10 | Users → posts → comments | 0.0577 + 0.0015 = **0.0592** | 0.0482 + 0.0008 = **0.0491** | 0.0560 + 0.0009 = **0.0569** | 0.0874 + 0.0012 = **0.0886** |
| 100 | Users | 0.0292 + 0.0013 = **0.0305** | 0.0388 + 0.0008 = **0.0397** | 0.0301 + 0.0012 = **0.0313** | 0.0451 + 0.0009 = **0.0460** |
| 100 | Users → posts | 0.1212 + 0.0040 = **0.1252** | 0.1270 + 0.0021 = **0.1292** | 0.1256 + 0.0022 = **0.1278** | 0.2279 + 0.0027 = **0.2306** |
| 100 | Users → posts → comments | 0.3115 + 0.0076 = **0.3192** | 0.3155 + 0.0042 = **0.3197** | 0.2969 + 0.0046 = **0.3015** | 0.5950 + 0.0065 = **0.6015** |
| 1,000 | Users | 0.1424 + 0.0064 = **0.1488** | 0.2342 + 0.0046 = **0.2387** | 0.1929 + 0.0061 = **0.1990** | 0.3509 + 0.0058 = **0.3567** |
| 1,000 | Users → posts | 1.00 + 0.0116 = **1.01** | 1.10 + 0.0234 = **1.12** | 1.06 + 0.0122 = **1.07** | 2.08 + 0.0148 = **2.10** |
| 1,000 | Users → posts → comments | 2.89 + 0.0308 = **2.92** | 2.89 + 0.0536 = **2.95** | 2.73 + 0.0274 = **2.75** | 5.63 + 0.0271 = **5.66** |
| 10,000 | Users | 1.30 + 0.0284 = **1.33** | 2.20 + 0.0638 = **2.26** | 1.87 + 0.0375 = **1.91** | 3.47 + 0.0306 = **3.50** |
| 10,000 | Users → posts | 9.74 + 0.0937 = **9.84** | 10.78 + 0.2134 = **11.00** | 10.71 + 0.1101 = **10.83** | 20.32 + 0.1191 = **20.44** |
| 10,000 | Users → posts → comments | 28.10 + 0.2587 = **28.36** | 29.87 + 0.3132 = **30.18** | 28.52 + 0.2497 = **28.77** | 56.34 + 0.2729 = **56.61** |
| 100,000 | Users | 12.92 + 0.2688 = **13.19** | 22.55 + 0.6313 = **23.18** | 19.08 + 0.5047 = **19.59** | 38.05 + 0.2715 = **38.32** |
| 100,000 | Users → posts | 98.22 + 0.9277 = **99.15** | 108.92 + 1.27 = **110.19** | 127.06 + 0.9620 = **128.02** | 219.79 + 0.9171 = **220.71** |
| 100,000 | Users → posts → comments | 290.15 + 2.21 = **292.36** | 303.94 + 3.22 = **307.16** | 327.76 + 2.24 = **330.00** | 616.48 + 2.48 = **618.96** |
| 1,000,000 | Users | 131.71 + 2.46 = **134.17** | 211.85 + 3.74 = **215.59** | 251.87 + 4.33 = **256.20** | 496.80 + 2.87 = **499.66** |
| 1,000,000 | Users → posts | 1030.53 + 13.86 = **1044.40** | 1120.73 + 11.46 = **1132.19** | 1640.33 + 16.48 = **1656.81** | 2484.21 + 17.86 = **2502.07** |
| 1,000,000 | Users → posts → comments | 2954.14 + 24.69 = **2978.83** | 3112.92 + 28.31 = **3141.24** | 5319.99 + 77.27 = **5397.26** | 6372.81 + 108.17 = **6480.98** |

## Method and limits

Main comparisons use prepared queries and three fresh processes per method/case, with rotating order, warm repeated reads, natural GC, no explicit collection and no raised heap limit. Each process reports its median batch mean; min/max show process variation. SQL construction/preparation, process startup, fixture generation, sink construction and correctness hashing are excluded. Actual public API controls include their normal planning.

Generation/pipeline includes SQLite/driver work, mapping/stringification when needed, and completion of the shared writable. ExportLite retains real batch stitching, byte-length scans, cancellation checks and event-loop yields. Encoding sums synchronous `Buffer.from(chunk, "utf8")` intervals, including allocation. Complete-value methods encode one whole string; ExportLite encodes normal buffered chunks. The sink discards bytes; HTTP headers/framing, tRPC envelopes, socket backpressure, TLS, transfer, client parsing and compression are outside these measurements. This is not an end-to-end HTTP server benchmark.

Peak RSS includes process startup, unmeasured validation and warmups, so it is not a per-response or per-phase memory reading. All methods load the same benchmark modules. The original short ASCII fixture isolates structure/record overhead; it does not replace the separate varied/Unicode export datasets. Small absolute differences must be read against the process ranges. These results apply to this machine and workload.

Environment: darwin 25.4.0 arm64; Apple M1 Pro; Node v26.12.0; V8 14.6.202.34-node.39.

Fixture SHA-256: `2932e4b4087e24ba2d4d6ba12d8ce0aff08f50b4640f0a240683d82d92c9e364`. Harness fingerprint: `d17b509a5b918c1e05da0c7a9fc6ff6133f464d66c7405bbaf575ebc2e38536b`.

[Reproduction and adapter details](matched-api/README.md). [CSV](results/matched-api/results.csv). [Summary](results/matched-api/summary.json). [Configuration/source hashes](results/matched-api/configuration.json). [Raw workers](results/matched-api/raw/).
