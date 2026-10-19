# Wide CSV memory investigation

Measured October 18, 2026 on Apple M1 Pro and the same Node 26.12.0 executable, SQLite 3.53.4 and seeded fixtures as the [initial CSV comparison](CSV.md). Registry versions were rechecked: better-sqlite3 13.0.3, zip-stream 7.0.5, csv-stringify 6.9.0 and csv-parse 7.0.3 remain current. Pins are unchanged.

The implemented fix removes redundant wide-batch copies. Median worker peak RSS falls about 6% for plain CSV and 18% for CSV ZIP, with comparable speed and identical output hashes. It adds no API options, dependencies, sizing policy or changes to the callback/drain handling.

## What CSV does

1. The planner selects fields and their output names. JavaScript constructs the header once. Declared columns or Drizzle metadata avoid discovery preflights.
2. SQLite constructs each CSV record using built-in functions. `typeof()` distinguishes NULL, text, numeric and unsupported BLOB values. Text is surrounded by quotes and `replace()` doubles embedded quotes; NULL becomes an empty cell; numbers use `CAST(... AS TEXT)`. `concat_ws()` joins cells with commas. Declared boolean/JSON modes use the existing SQL conversions. There is no custom SQLite extension or intermediate full JSON document.
3. Eligible tables use the existing recursive, indexed-seek statement to visit groups of 256 records. `group_concat()` joins records with CRLF. This is one export statement, not a query per batch. A custom query or fallback table yields one SQLite-formatted CSV record at a time.
4. On UTF-8 native table exports, the driver returns a Buffer and row count for each batch. The temporary two-byte ASCII prefix is checked and removed using a view, preserving the UTF-16 declaration guard even for a leading NUL cell. The writer applies the existing 64 KiB flush target, waits for write callbacks and drain, and optionally feeds the ZIP compressor. Web streams, paths and Node destinations share this delivery path. UTF-16 and Turso use text delivery and the same record semantics.

The driver still copies SQLite BLOB results into its own Node Buffer: the checked 13.0.3 implementation uses `Napi::Buffer<char>::Copy` in `src/util/data.cpp`. The optimization below removes the subsequent writer copy, rather than claiming zero copies from SQLite to the destination.

## Why memory was higher

The batch already contained CSV bytes, but its final CRLF was appended by the writer. Each wide batch therefore became a list containing a Buffer plus a string. `Buffer.concat()` allocated another buffer containing the same batch and separator. This happened even though the batch already exceeded the flush target and could otherwise be written immediately.

Separate instrumented workers ran nine wide exports each. They counted driver batch bytes, large `Buffer.concat()` copies and string-to-buffer encodings, sampled memory and observed GC. The original table path produced 531 native batch buffers totaling about 125.5 MiB, then copied about 125.5 MiB again in the writer. Optimized manual JS instead encoded about 125.5 MiB from its buffered strings, without native batch buffers or large concatenation copies.

In those profiles, table buffer/native memory peaked near 70 MiB plain and 63 MiB zipped, versus about 8/10 MiB for manual JS. The table path used far fewer JS heap objects and had much less frequent minor GC. This is consistent with unused large Buffers remaining until later collections; manual JS's row/string allocation causes more frequent collection in this workload. After exports and connection close, diagnostic collections reduced external memory to roughly 3 MiB. These observations explain temporary allocation pressure; they are not a long-lived leak qualification.

Buffer backing memory is separate from ordinary JS heap usage. Node reports it under `arrayBuffers` and also includes it in `external`; the two should not be added together. RSS includes the whole process. [Node memory accounting](https://nodejs.org/api/process.html#processmemoryusage).

## Small fix

- SQLite includes the final CRLF in each CSV batch. Both local and remote producers therefore leave complete batch records intact; query fallbacks still add the per-record CRLF.
- When a flush contains one Buffer, the writer passes that Buffer to its existing send method. Strings and multiple fragments retain their existing encoding/coalescing path. Small batches still coalesce to the same target, and the first header-plus-batch write can still require a copy.

The profile's copied bytes fall from about 125.5 MiB to 2.4 MiB across nine exports: roughly 98% less writer copying. The number of destination writes and their boundaries stay the same for the matched fixtures. The 256-row size, 64 KiB flush target and ZIP settings remain fixed.

## Matched results

Five alternating before/after rounds use fresh processes and the same immutable fixture files. Each worker verifies a hash, performs two warmups and measures three batches of requests, with natural GC. Wide is 15,000 records with approximately 1 KiB notes and occasional larger notes; output is 14,619,815 CSV bytes or 3,999,471 ZIP bytes. The narrow and tiny controls are also retained in the raw data. No profiling hooks or forced GC run in this timing comparison.

| Wide output | Method | Total ms | Median peak RSS MiB | Highest peak RSS MiB |
| --- | --- | ---: | ---: | ---: |
| Plain | Previous ExportLite | 39.24 | 178.6 | 186.3 |
| Plain | Updated ExportLite | 38.20 | 168.2 | 168.8 |
| Plain | Manual JS streaming | 48.45 | 138.9 | 139.7 |
| ZIP | Previous ExportLite | 108.88 | 177.8 | 185.1 |
| ZIP | Updated ExportLite | 108.28 | 146.0 | 149.9 |
| ZIP | Manual JS streaming | 108.84 | 119.5 | 123.1 |

Elapsed time changes are -2.6% plain and -0.6% zipped. The useful outcome is lower allocation and memory without an observed speed loss. Wide memory remains above manual JS because the native batch buffers still exist and their collection/reuse differs from the row/string path. This change does not set a hard RAM ceiling.

Narrow table timings stay within about 1.4%, and median peak RSS within about 1.9%; query fallback timings stay within about 4%. Tiny timings fluctuate at sub-millisecond durations. The complete CSV matrix covers 150 fresh workers and 18 cases. All before/after hashes match, including ZIP hashes, and table CSV/ZIP also matches the manual JS control. Imports/setup and warmups count toward whole-process peak RSS; connection setup is excluded from elapsed export time. Output drains to a counting Node writable, without disk or network timing.

## Validation and reproduction

The build, types, lint and 408 tests pass. Added tests pause a later wide native CSV batch, verify bounded production and await cancellation for plain and ZIP delivery, preserve caller stream ownership and reuse the database afterward. An all-NULL CSV column crosses a batch boundary with exact CRLF/row-count assertions. Existing CSV cases independently parse/decode output and retain UTF-16, aliases, Unicode/NUL, empty results, BLOB failures and remote session behavior.

The JSON/ZIP regression matrix covers 144 fresh workers and 24 cases across native/Drizzle table/query APIs; all before/after output hashes match. Bulk elapsed changes stay between -3.5% and +4.2%. Median peak RSS changes stay between -1.6% and +6.5%. Two tiny ZIP query cases initially measured +19.5%/+11.0%; a five-pair recheck measured -2.4%/+0.7%, so those slowdowns did not repeat. [Focused JSON recheck](../../outputs/csv-memory/json-recheck/summary.json).

The before build is commit `09404fd2dcd880590dbf22010bc2cbad1adfc4a5`. Build that checkout separately into `outputs/csv-memory/baseline/dist` with a sibling `node_modules` link to the pinned dependencies; baseline binaries are not committed. Build the candidate, then use the recorded Node 26.12.0 executable from the repository root:

```sh
node outputs/csv-memory/compare.mjs
node outputs/csv-memory/run-profile.mjs
EXPORTLITE_BEFORE="$PWD/outputs/csv-memory/baseline/dist" \
BENCH_OUT="$PWD/outputs/csv-memory/json-regression" \
node outputs/phase2/compare.mjs
```

The runner regenerates missing fixtures with seed 20261017. Profiling intentionally monkey-patches allocation/iteration APIs and performs three diagnostic GCs only after work finishes; use the separate, uninstrumented comparison for performance claims.

Evidence: [paired CSV summary](../../outputs/csv-memory/comparison/summary.json), [all CSV workers](../../outputs/csv-memory/comparison/all.json), [runtime/build/fixture hashes](../../outputs/csv-memory/comparison/configuration.json), [allocation checks](../../outputs/csv-memory/profiles/checks.json) and [JSON regression](../../outputs/csv-memory/json-regression/summary.json). Turso remains locally protocol-tested and experimental; this investigation makes no cloud-performance claim.
