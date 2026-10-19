import { readFile, writeFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./results/${name}.json`, import.meta.url), "utf8"),
  );
const [large, small, buffering, cap] = await Promise.all([
  load("gzip-output-buffer-comparison"),
  load("gzip-output-buffer-small"),
  load("gzip-buffer-diagnosis"),
  load("gzip-chunk-fix-wide"),
]);
const n = (value, digits = 2) => value.toFixed(digits);
const get = (report, method, mode) =>
  report.results.find((r) => r.method === method && r.compression === mode)
    .summary;
const modes = { "gzip-1": "Gzip level 1", "gzip-default": "Default gzip" };
const methods = {
  exportlite: "ExportLite / 16 KiB",
  "object-stream": "JS objects / 16 KiB",
  "exportlite-gzip-slab64k": "ExportLite / 64 KiB",
  "object-stream-gzip-slab64k": "JS objects / 64 KiB",
  "exportlite-gzip-slab256k": "ExportLite / 256 KiB",
  "object-stream-gzip-slab256k": "JS objects / 256 KiB",
};
const table = (
  report,
) => `| Exporter / compression output buffer | Mode | Total seconds | Min–max seconds | Peak RSS MiB | Output MiB | Destination writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${report.results.map(({ method, compression, summary: s }) => `| ${methods[method]} | ${modes[compression]} | ${n(s.durationMs / 1000)} | ${n(s.minDurationMs / 1000)}–${n(s.maxDurationMs / 1000)} | ${n(s.peakRssMiB, 1)} | ${n(s.bytes / 1_048_576)} | ${s.encodedChunks} |`).join("\n")}`;
const old = get(large, "exportlite", "gzip-default");
const changed = get(large, "exportlite-gzip-slab256k", "gzip-default");
const oldFast = get(large, "exportlite", "gzip-1");
const newFast = get(large, "exportlite-gzip-slab256k", "gzip-1");
const env = large.environment;
const text = `# ExportLite — compression buffering investigation

The large-record slowdown comes from the interaction between coarse SQLite JSON batches and Node's small default compression output buffer. Increasing the compressor's output buffer from 16 KiB to 256 KiB reduced ExportLite's elapsed time by ${n(100 * (1 - newFast.durationMs / oldFast.durationMs), 1)}% with gzip level 1 and ${n(100 * (1 - changed.durationMs / old.durationMs), 1)}% with default gzip in the controlled large-record comparison. Both exporters were given the same settings. Their tuned times are close; do not infer a universal winner from these runs.

## Evidence and mechanism

- The byte counter measured ExportLite writes averaging ${n(old.meanRawChunkBytes / 1024, 1)} KiB, versus ${n(get(large, "object-stream", "gzip-default").meanRawChunkBytes / 1024, 1)} KiB for JS object streaming. The 64 KiB export option is a flush trigger, so one 256-row SQLite batch can be larger.
- The installed Node ${env.node} zlib implementation was inspected directly. In lib/zlib.js processCallback(), exhaustion of the output buffer returns to JavaScript, allocates the next buffer and submits the remaining input to the native compressor again. Large input chunks can require several such round trips. SQLite batch generation runs synchronously on that same JavaScript thread.
- A larger compression output buffer reduces those round trips and destination writes while keeping the same algorithm, compression level, input bytes, row count and SQL. This is distinct from the stream's highWaterMark queue threshold. Node documents the memory/call-count tradeoff in its [compression memory tuning guide](https://nodejs.org/api/zlib.html#memory-usage-tuning), and its [stream buffering documentation](https://nodejs.org/api/stream.html#buffering) explains highWaterMark.
- Measured fact: changing only the compression output-buffer setting produces the gains below. The explanation that fewer main-thread/worker handoffs improve overlap is supported by the installed source and this controlled experiment; the benchmark does not provide a CPU flamegraph or claim all time is spent in one callback.

## Large varied records: 100,000 rows

Five measured runs plus one warmup per combination, each in a fresh process, with positions rotated. The seeded fixture and byte-for-byte validation are the same as in the earlier varied-data comparison.

${table(large)}

## Small varied records: 1,000,000 rows

The selected 256 KiB setting was also checked with five measured runs and one warmup on the short-message fixture.

${table(small)}

## Changes rejected

- Raising gzip's highWaterMark to 512 KiB did not fix the issue. For ExportLite, level 1 changed from ${n(get(buffering, "exportlite", "gzip-1").durationMs / 1000)} s to ${n(get(buffering, "exportlite-gzip-512k", "gzip-1").durationMs / 1000)} s, and default gzip from ${n(get(buffering, "exportlite", "gzip-default").durationMs / 1000)} s to ${n(get(buffering, "exportlite-gzip-512k", "gzip-default").durationMs / 1000)} s. These were three measured runs plus a warmup.
- Capping ExportLite's output writes at 64 KiB also failed to improve throughput. In a paired five-run comparison, default gzip changed from ${n(get(cap, "exportlite-before", "gzip-default").durationMs / 1000)} s to ${n(get(cap, "exportlite", "gzip-default").durationMs / 1000)} s; uncompressed output also became slower. That code was reverted. Its build is retained under baselines/rejected-chunk-cap for reproducibility.

The core source, API, fixed 256-row batches, stream fallbacks and reliability behavior remain unchanged. No compression dependency was added. The practical change belongs in the existing downstream compression stream:

\`\`\`js
const gzip = createGzip({
  level: 1,
  chunkSize: 256 * 1024,
});
\`\`\`

The extra compression output buffer is 240 KiB over the default per compressor; this is not a bound on overall process memory. Peak process RSS is reported above. Both implementations decode to identical JSON and produce matching encoded byte counts for every setting. The setting does not request a flush, reset the compressor between batches or alter compression level. These are local-file results; network transfer and client decompression are outside timing.

## ZIP API direction

The proposed user-facing option can stay small:

\`\`\`ts
// Proposed ZIP adapter API; this investigation does not implement zip: true.
await exportTable(db, "users", {
  format: "json",
  zip: true,
  output: response,
  end: true,
});
\`\`\`

This would send a stream of ZIP bytes containing users.json (or users.jsonl for JSONL). The existing export engine would feed a ZIP entry, and the archive stream would feed the file or HTTP response with backpressure. It would not materialize the entire JSON or archive in a Buffer. Compression-buffer tuning belongs inside that adapter. Actual ZIP output requires separate validation of its archive entry, final directory, cancellation, cleanup and large-file support; the gzip results here do not measure that path.

## Environment and reproduction

- ${env.cpu}; ${env.logicalCpus} logical CPUs; ${n(env.memoryGiB, 1)} GiB RAM; ${env.platform} ${env.release} ${env.architecture}; Node ${env.node}; better-sqlite3 ${env.driver}; SQLite ${env.sqlite}; zlib ${env.zlib}. Latest better-sqlite3 was checked before starting; no dependency versions changed.
- Full timing includes planning, UTF-8 output, compression finalization and file close. Data generation, driver/process startup, decompression checks and SHA-256 verification are outside the timer. Files are written to local temporary storage without fsync.
- Each combination passed an independent 257-row parsed JSON comparison. Every warmup and measured output was then streamed through gunzip and SHA-256 outside the worker, checking decoded content, raw byte counts, encoded filesystem size and gzip trailer integrity.
- RSS is the median absolute process high-water mark, including native memory and startup. OS caches, GC, scheduling and instrumentation affect measurements. These synthetic fixtures do not represent every production workload.

\`\`\`sh
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,exportlite-gzip-slab64k,object-stream-gzip-slab64k,exportlite-gzip-slab256k,object-stream-gzip-slab256k --compressions=gzip-1,gzip-default --destinations=file --out=benchmarks/results/gzip-output-buffer-comparison.json
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,exportlite-gzip-slab256k,object-stream-gzip-slab256k --compressions=gzip-1,gzip-default --destinations=file --out=benchmarks/results/gzip-output-buffer-small.json
node benchmarks/gzip-investigation-report.mjs
\`\`\`

Raw results: [output-buffer comparison](results/gzip-output-buffer-comparison.json), [small records](results/gzip-output-buffer-small.json), [queue-threshold experiment](results/gzip-buffer-diagnosis.json), [rejected write-cap experiment](results/gzip-chunk-fix-wide.json). Original varied-data results remain in [VARIED-COMPRESSION.md](VARIED-COMPRESSION.md).
`;
await writeFile(new URL("./GZIP-INVESTIGATION.md", import.meta.url), text);
console.log("Generated benchmarks/GZIP-INVESTIGATION.md");
