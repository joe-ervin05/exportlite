# ExportLite versus naive JavaScript exports

This comparison adds the common implementation that loads every SQLite row into a JS array and serializes the entire array at once:

```js
const rows = db.prepare(sql).all();
const json = JSON.stringify(rows);
await writeFile("export.json", json);
```

The measured `naive-all` method performs those same fetch and serialization steps, then passes the complete JSON string through the counted destination used by the other methods. For ZIP, that complete string goes to the same tuned ZIP writer: zip-stream 7.0.5, DEFLATE level 1, a 256 KiB zlib output buffer, one `data.json` entry and ZIP64. Its row fetching and JSON serialization hold the whole result in memory; archive bytes are written directly to the destination.

ExportLite and JS object streaming are rerun alongside it, with identical fixtures, file-completion rules and ZIP settings. ExportLite uses its public `exportTable()` API and `zip: true` option. JS streaming uses `iterate()` plus per-row `JSON.stringify()` and a 64 KiB flush target. ExportLite retains its fixed 256-row SQLite JSON batches. The package implementation and API are unchanged.

## Results

Median of five fresh-process measured runs after one warmup per case, with rotating order. Total time includes database fetching, JSON serialization, output setup, compression and checksums when enabled, ZIP finalization, destination callbacks and file close. Process/module startup, fixture creation and independent output validation are excluded. The local filesystem is cached and writes do not use fsync.

| Dataset | Exporter | Output | Total seconds (min–max) | File MiB | Peak RSS MiB | Sampled heap MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1m smaller records | ExportLite | JSON | 0.575 (0.571–0.593) | 79.51 | 103.0 | 14.6 |
| 1m smaller records | JS streaming | JSON | 1.009 (0.967–1.168) | 79.51 | 101.3 | 13.9 |
| 1m smaller records | Naive JS all + stringify | JSON | 0.738 (0.727–0.782) | 79.51 | 613.0 | 218.5 |
| 1m smaller records | ExportLite | ZIP | 0.679 (0.671–0.695) | 20.37 | 104.9 | 15.1 |
| 1m smaller records | JS streaming | ZIP | 1.087 (1.073–1.110) | 20.37 | 110.6 | 13.9 |
| 1m smaller records | Naive JS all + stringify | ZIP | 1.284 (1.241–1.338) | 20.37 | 629.7 | 219.9 |
| 100k larger records | ExportLite | JSON | 0.718 (0.710–0.724) | 96.25 | 120.9 | 29.6 |
| 100k larger records | JS streaming | JSON | 0.793 (0.781–0.800) | 96.25 | 122.5 | 24.1 |
| 100k larger records | Naive JS all + stringify | JSON | 0.846 (0.835–0.881) | 96.25 | 978.8 | 354.7 |
| 100k larger records | ExportLite | ZIP | 0.890 (0.889–1.026) | 25.88 | 124.9 | 28.9 |
| 100k larger records | JS streaming | ZIP | 0.910 (0.902–0.954) | 25.88 | 124.5 | 24.6 |
| 100k larger records | Naive JS all + stringify | ZIP | 1.529 (1.518–1.630) | 25.88 | 1001.1 | 355.1 |

Peak RSS is the median of the absolute process high-water memory for the five runs, including Node, loaded modules, SQLite cache, JS allocations and native buffers. Sampled heap is a lower bound on JS heap, sampled at flushes, every 5 ms and immediately after the naive method's full array and JSON string allocations. It excludes native memory. All methods load the same benchmark dependencies. The measurements reflect these datasets and machine; none of the streaming buffer settings is a process-wide RAM cap.

## What changed relative to naive JS

- **1m smaller records, plain JSON:** ExportLite took 0.575 versus 0.738 seconds (22.1% less time) and used 83.2% less peak RSS (103.0 versus 613.0 MiB).
- **1m smaller records, ZIP:** ExportLite took 0.679 versus 1.284 seconds (47.1% less time) and used 83.3% less peak RSS (104.9 versus 629.7 MiB).
- **100k larger records, plain JSON:** ExportLite took 0.718 versus 0.846 seconds (15.1% less time) and used 87.6% less peak RSS (120.9 versus 978.8 MiB).
- **100k larger records, ZIP:** ExportLite took 0.890 versus 1.529 seconds (41.8% less time) and used 87.5% less peak RSS (124.9 versus 1001.1 MiB).

The naive method can be faster than per-row JS streaming despite using much more memory. Its single native `all()` call and one `JSON.stringify()` call avoid the per-record serialization calls, JS loop and repeated output buffering of the JS streaming baseline. The results above measure the combined outcome rather than attributing time to each step. Streaming's memory benefit is separate from whether it wins on total time.

The naive path completes `all()` and then `JSON.stringify()` before it starts writing JSON. Streaming begins writing while rows are still being fetched. Streaming ZIP can also overlap fetching/serialization with asynchronous compression; the naive path supplies its full JSON string after those stages have finished. The timing includes UTF-8 conversion of that string when it is written. These are differences in how the implementations run; the benchmark does not separately attribute their individual costs.

The comparison uses the same ZIP implementation rather than comparing compression libraries. It therefore measures the cost of fetching and serializing everything at once, including the resulting memory pressure, while keeping ZIP settings aligned. All methods produced identical JSON bytes and identical ZIP file sizes for these fixtures.

## Data, validation and limits

The seeded varied fixtures are the same shapes as the previous ZIP runs: international names, distinct references, amounts, dates, NULLs, variable-length support notes and occasional longer notes. Seed: 20261017. They are synthetic business records with recurring templates/categories. Exact distributions, samples, environments and every measured run are saved in the raw results.

All six method/output combinations matched a parsed 257-row fixture before timing. Every completed warmup and measured file was hashed outside the timed process. ZIP files were fully decoded with an independent reader, with CRC-32 and declared sizes checked. Decoded SHA-256 hashes matched across all methods and both output modes. Measured encoded sizes matched the filesystem. No large JSON array was loaded by the validation process.

These are local file exports, not network downloads. Client transfer/decompression, concurrent requests and other schemas may change the tradeoffs. Rowid table exports are timed; the package's query/view/virtual/WITHOUT ROWID fallbacks are outside this timing comparison.

Environment: Apple M1 Pro; darwin arm64; Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4; zip-stream 7.0.5. Package versions were checked October 17, 2026.

## Reproduce

Run sequentially after building:

```sh
pnpm build
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,naive-all --compressions=none,zip --destinations=file --out=benchmarks/results/naive-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,naive-all --compressions=none,zip --destinations=file --out=benchmarks/results/naive-wide.json
node benchmarks/naive-report.mjs
```

Raw runs: [smaller records](results/naive-narrow.json), [larger records](results/naive-wide.json). [Earlier ZIP-only comparison](ZIP.md).
