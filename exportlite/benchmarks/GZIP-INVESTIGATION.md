# ExportLite — compression buffering investigation

The large-record slowdown comes from the interaction between coarse SQLite JSON batches and Node's small default compression output buffer. Increasing the compressor's output buffer from 16 KiB to 256 KiB reduced ExportLite's elapsed time by 37.3% with gzip level 1 and 21.9% with default gzip in the controlled large-record comparison. Both exporters were given the same settings. Their tuned times are close; do not infer a universal winner from these runs.

## Evidence and mechanism

- The byte counter measured ExportLite writes averaging 251.4 KiB, versus 64.9 KiB for JS object streaming. The 64 KiB export option is a flush trigger, so one 256-row SQLite batch can be larger.
- The installed Node v24.19.0 zlib implementation was inspected directly. In lib/zlib.js processCallback(), exhaustion of the output buffer returns to JavaScript, allocates the next buffer and submits the remaining input to the native compressor again. Large input chunks can require several such round trips. SQLite batch generation runs synchronously on that same JavaScript thread.
- A larger compression output buffer reduces those round trips and destination writes while keeping the same algorithm, compression level, input bytes, row count and SQL. This is distinct from the stream's highWaterMark queue threshold. Node documents the memory/call-count tradeoff in its [compression memory tuning guide](https://nodejs.org/api/zlib.html#memory-usage-tuning), and its [stream buffering documentation](https://nodejs.org/api/stream.html#buffering) explains highWaterMark.
- Measured fact: changing only the compression output-buffer setting produces the gains below. The explanation that fewer main-thread/worker handoffs improve overlap is supported by the installed source and this controlled experiment; the benchmark does not provide a CPU flamegraph or claim all time is spent in one callback.

## Large varied records: 100,000 rows

Five measured runs plus one warmup per combination, each in a fresh process, with positions rotated. The seeded fixture and byte-for-byte validation are the same as in the earlier varied-data comparison.

| Exporter / compression output buffer | Mode | Total seconds | Min–max seconds | Peak RSS MiB | Output MiB | Destination writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ExportLite / 16 KiB | Gzip level 1 | 1.30 | 1.28–1.37 | 111.5 | 25.88 | 2048 |
| JS objects / 16 KiB | Gzip level 1 | 1.06 | 1.05–1.10 | 115.6 | 25.88 | 2964 |
| ExportLite / 64 KiB | Gzip level 1 | 1.06 | 1.03–1.09 | 113.8 | 25.88 | 806 |
| JS objects / 64 KiB | Gzip level 1 | 0.89 | 0.88–0.95 | 116.5 | 25.88 | 1722 |
| ExportLite / 256 KiB | Gzip level 1 | 0.82 | 0.81–0.82 | 117.6 | 25.88 | 495 |
| JS objects / 256 KiB | Gzip level 1 | 0.83 | 0.82–0.90 | 119.2 | 25.88 | 1411 |
| ExportLite / 16 KiB | Default gzip | 1.99 | 1.95–2.07 | 113.9 | 21.55 | 1771 |
| JS objects / 16 KiB | Default gzip | 1.72 | 1.66–1.79 | 114.9 | 21.55 | 2492 |
| ExportLite / 64 KiB | Default gzip | 1.64 | 1.63–1.65 | 111.1 | 21.55 | 736 |
| JS objects / 64 KiB | Default gzip | 1.61 | 1.58–1.62 | 115.1 | 21.55 | 1457 |
| ExportLite / 256 KiB | Default gzip | 1.55 | 1.53–1.75 | 112.8 | 21.55 | 478 |
| JS objects / 256 KiB | Default gzip | 1.58 | 1.55–1.62 | 115.4 | 21.55 | 1199 |

## Small varied records: 1,000,000 rows

The selected 256 KiB setting was also checked with five measured runs and one warmup on the short-message fixture.

| Exporter / compression output buffer | Mode | Total seconds | Min–max seconds | Peak RSS MiB | Output MiB | Destination writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ExportLite / 16 KiB | Gzip level 1 | 0.81 | 0.79–0.87 | 97.8 | 20.37 | 2151 |
| JS objects / 16 KiB | Gzip level 1 | 1.17 | 1.15–1.35 | 99.1 | 20.37 | 2151 |
| ExportLite / 256 KiB | Gzip level 1 | 0.64 | 0.63–0.76 | 100.0 | 20.37 | 929 |
| JS objects / 256 KiB | Gzip level 1 | 1.11 | 1.01–1.39 | 107.7 | 20.37 | 929 |
| ExportLite / 16 KiB | Default gzip | 1.54 | 1.46–1.62 | 95.5 | 17.44 | 1862 |
| JS objects / 16 KiB | Default gzip | 1.57 | 1.53–1.63 | 98.1 | 17.44 | 1862 |
| ExportLite / 256 KiB | Default gzip | 1.41 | 1.38–1.49 | 98.9 | 17.44 | 815 |
| JS objects / 256 KiB | Default gzip | 1.43 | 1.40–1.78 | 106.4 | 17.44 | 815 |

## Changes rejected

- Raising gzip's highWaterMark to 512 KiB did not fix the issue. For ExportLite, level 1 changed from 1.31 s to 1.41 s, and default gzip from 1.99 s to 2.27 s. These were three measured runs plus a warmup.
- Capping ExportLite's output writes at 64 KiB also failed to improve throughput. In a paired five-run comparison, default gzip changed from 1.99 s to 2.08 s; uncompressed output also became slower. That code was reverted. Its build is retained under baselines/rejected-chunk-cap for reproducibility.

The core source, API, fixed 256-row batches, stream fallbacks and reliability behavior remain unchanged. No compression dependency was added. The practical change belongs in the existing downstream compression stream:

```js
const gzip = createGzip({
  level: 1,
  chunkSize: 256 * 1024,
});
```

The extra compression output buffer is 240 KiB over the default per compressor; this is not a bound on overall process memory. Peak process RSS is reported above. Both implementations decode to identical JSON and produce matching encoded byte counts for every setting. The setting does not request a flush, reset the compressor between batches or alter compression level. These are local-file results; network transfer and client decompression are outside timing.

## ZIP API direction

The proposed user-facing option can stay small:

```ts
// Proposed ZIP adapter API; this investigation does not implement zip: true.
await exportTable(db, "users", {
  format: "json",
  zip: true,
  output: response,
  end: true,
});
```

This would send a stream of ZIP bytes containing users.json (or users.jsonl for JSONL). The existing export engine would feed a ZIP entry, and the archive stream would feed the file or HTTP response with backpressure. It would not materialize the entire JSON or archive in a Buffer. Compression-buffer tuning belongs inside that adapter. Actual ZIP output requires separate validation of its archive entry, final directory, cancellation, cleanup and large-file support; the gzip results here do not measure that path.

## Environment and reproduction

- Apple M1 Pro; 10 logical CPUs; 32.0 GiB RAM; darwin 25.4.0 arm64; Node v24.19.0; better-sqlite3 13.0.3; SQLite 3.53.4; zlib 1.3.2.1-motley-3246f1b. Latest better-sqlite3 was checked before starting; no dependency versions changed.
- Full timing includes planning, UTF-8 output, compression finalization and file close. Data generation, driver/process startup, decompression checks and SHA-256 verification are outside the timer. Files are written to local temporary storage without fsync.
- Each combination passed an independent 257-row parsed JSON comparison. Every warmup and measured output was then streamed through gunzip and SHA-256 outside the worker, checking decoded content, raw byte counts, encoded filesystem size and gzip trailer integrity.
- RSS is the median absolute process high-water mark, including native memory and startup. OS caches, GC, scheduling and instrumentation affect measurements. These synthetic fixtures do not represent every production workload.

```sh
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,exportlite-gzip-slab64k,object-stream-gzip-slab64k,exportlite-gzip-slab256k,object-stream-gzip-slab256k --compressions=gzip-1,gzip-default --destinations=file --out=benchmarks/results/gzip-output-buffer-comparison.json
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,exportlite-gzip-slab256k,object-stream-gzip-slab256k --compressions=gzip-1,gzip-default --destinations=file --out=benchmarks/results/gzip-output-buffer-small.json
node benchmarks/gzip-investigation-report.mjs
```

Raw results: [output-buffer comparison](results/gzip-output-buffer-comparison.json), [small records](results/gzip-output-buffer-small.json), [queue-threshold experiment](results/gzip-buffer-diagnosis.json), [rejected write-cap experiment](results/gzip-chunk-fix-wide.json). Original varied-data results remain in [VARIED-COMPRESSION.md](VARIED-COMPRESSION.md).
