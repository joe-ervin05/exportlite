# Declared table exports: primary keys and encoding

Measured October 18, 2026. Compared the immediately preceding typed-column implementation (saved baseline) with the new declared-table path. Same original varied fixture files, exact Node 26.12.0, better-sqlite3 13.0.3, SQLite 3.53.4, Apple M1 Pro. No HTTP or remote database latency is included.

The baseline receives the same typed field selection with id.notNull(); the new path receives id.primaryKey(), with encoding defaulting to utf8. Both prepare fresh data statements and use fixed 256-row batches, a 64 KiB output flush target, ZIP level 1, memLevel 9, and a 256 KiB zlib output buffer. These fixtures use an INTEGER PRIMARY KEY alias of rowid; other index layouts can have different costs.

## Results

| Case | Old time (ms) | New time (ms) | Change | Output (MiB) | Median peak RSS, old → new (MiB) | Highest observed RSS, old → new (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| table-1 | 0.1435 | 0.1463 | +1.95% | 0.000073 | 107.6 → 108.4 | 107.9 → 108.7 |
| cold-table-1 | 0.3745 | 0.2509 | -33.00% | 0.000073 | 82.8 → 80.2 | 82.9 → 80.5 |
| table-10 | 0.1461 | 0.1490 | +2.00% | 0.000782 | 108.2 → 109.1 | 108.4 → 109.3 |
| table-1000 | 0.5900 | 0.6015 | +1.95% | 0.076696 | 115.6 → 114.3 | 119.2 → 116.8 |
| narrow-plain | 370.4014 | 370.5000 | +0.03% | 79.507682 | 153.2 → 152.1 | 156.2 → 157.7 |
| narrow-zip | 554.0801 | 558.5930 | +0.81% | 20.344024 | 147.2 → 147.5 | 176.7 → 152.6 |
| wide-plain | 146.1532 | 149.8442 | +2.53% | 96.245270 | 207.5 → 195.5 | 228.6 → 237.4 |
| wide-zip | 678.0447 | 679.5999 | +0.23% | 25.829152 | 193.4 → 189.4 | 198.6 → 197.2 |

Time is the median of five independent worker medians. Every worker warms up, then measures three request batches; each batch contains 200 requests for 1/10-row warm cases, 50 for the 1,000-row and cold cases, or one complete bulk export. Methods run sequentially, alternating order by round. Small exports consume Web streams through Response.arrayBuffer; bulk exports use a counting Node writable. Connection opening/closing is outside the cold-request timer. Natural garbage collection; no forced GC.

RSS is a whole-process high-water mark including module imports, correctness verification, warmup and repeated measurements, captured before separate query-count diagnostics. It is not incremental per-request memory. Both median worker peaks and the highest observed worker peak are reported because GC variation was substantial. Narrow JSON is 79.51 MiB, wide JSON 96.25 MiB; ZIP outputs are 20.34 MiB and 25.83 MiB.

## Interpretation

- Cold first exports are 33% faster: 0.3745 → 0.2509 ms, with non-overlapping observed worker timing ranges.
- Warm local exports are about 2% slower in median, a difference of roughly 3–11 microseconds, with overlapping worker ranges.
- Bulk JSON/ZIP median changes range from +0.03% to +2.53%, with overlapping ranges. There is no demonstrated bulk throughput improvement.
- Memory remains similar and variable. In particular, wide JSON has a lower median worker peak but a higher worst observed peak (228.6 → 237.4 MiB); this is not a consistent memory reduction.
- The main improvement is removal of metadata SQL operations: tracing a fresh connection records six preflight executions plus one data statement before, versus one data statement after. Warm connections record one schema-version check plus one data statement before, versus only the data statement after. This is SQL-operation counting, not a measurement of Turso HTTP requests.

## Correctness and reliability

All 80 workers verified encoded byte length and SHA-256. All 20 actual ZIP validation archives were independently decoded and checked against the original JSON digest and length; the independent reader checks CRC-32. Output bytes, including ZIP bytes, are identical between methods. There were 15,120 timed exports in the full comparison. A separate six-worker smoke run also passed before the full comparison.

249 tests pass, including cold declared exports with a prepare/iterate-only connection that rejects all metadata reads; 256-row boundaries; sparse and 64-bit keys; WITHOUT ROWID and rowid-shadowing tables; secondary unique integer keys; UTF-16LE/BE JSON/JSONL and ZIP output; wrong UTF-8 declaration failures; missing columns; independent lazy streams; cancellation/backpressure; and partial-file cleanup. ESM/CJS builds, type consumers, typecheck and full lint pass.

primaryKey() is a declaration of an existing unique, non-null key, not a schema migration or a uniqueness check. A single non-boolean integer key enables batching. Other declared projections use row streaming without preflight queries. The database encoding option selects native UTF-8 bytes or driver text conversion for UTF-16 databases; output always remains UTF-8.

Declared SQL plans depend only on the request and are bounded to 16 cached plans per connection, shared with discovered plans. A fresh statement is prepared every export. Missing columns therefore fail against the current schema, and data is never cached. Automatic discovery and column-name arrays retain the previous schema-version validation and storage fallbacks.

## Artifacts

- [Summary CSV](../../outputs/declared-primary-key/comparison/summary.csv)
- [Raw workers](../../outputs/declared-primary-key/comparison/all.json)
- [Configuration and fingerprints](../../outputs/declared-primary-key/comparison/configuration.json)
- [Validation](../../outputs/declared-primary-key/comparison/validation.json)
