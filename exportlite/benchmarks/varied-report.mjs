import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./results/${name}.json`, import.meta.url), "utf8"),
  );
const reports = await Promise.all(
  ["narrow", "wide"].map(async (kind) => ({
    kind,
    report: await load(`varied-compression-${kind}`),
    previous: await load(`compression-${kind}`),
  })),
);
const n = (value, digits = 2) => value.toFixed(digits);
const mib = (bytes) => bytes / 1_048_576;
const seconds = (ms) => n(ms / 1000);
const modes = {
  none: "None",
  "gzip-1": "Gzip level 1",
  "gzip-default": "Default gzip",
};
const names = {
  exportlite: "ExportLite",
  "object-stream": "JS object streaming",
};
const get = (report, method, mode) =>
  report.results.find((r) => r.method === method && r.compression === mode)
    .summary;
const change = (value, baseline) =>
  `${n(Math.abs(100 * (value / baseline - 1)), 1)}% ${value >= baseline ? "more" : "less"}`;
const sections = reports.map(({ kind, report, previous }) => {
  const { configuration: c, results } = report;
  assert.equal(c.profile, "varied");
  assert.equal(results.length, 6);
  assert.deepEqual(c.methods, ["exportlite", "object-stream"]);
  assert.deepEqual(c.compressions, ["none", "gzip-1", "gzip-default"]);
  assert.deepEqual(c.destinations, ["file"]);
  const fixture = report.fixtures[0];
  const sizes = fixture.noteUtf8Bytes;
  const nonNull = fixture.rows - fixture.nullNotes;
  const plain = get(report, "exportlite", "none");
  const fast = get(report, "exportlite", "gzip-1");
  const standard = get(report, "exportlite", "gzip-default");
  for (const mode of c.compressions)
    assert.equal(
      get(report, "exportlite", mode).bytes,
      get(report, "object-stream", mode).bytes,
    );
  const oldFast = get(previous, "exportlite", "gzip-1");
  const oldDefault = get(previous, "exportlite", "gzip-default");
  return `## ${fixture.rows.toLocaleString("en-US")} varied records, nominal ${c.width}-character notes

Uncompressed JSON is **${n(mib(plain.rawBytes))} MiB**. There are ${fixture.distinctNames.toLocaleString("en-US")} distinct names, ${fixture.distinctNonNullNotes.toLocaleString("en-US")} distinct notes among ${nonNull.toLocaleString("en-US")} non-NULL notes, and ${fixture.nullNotes.toLocaleString("en-US")} NULL notes (${n((100 * fixture.nullNotes) / fixture.rows, 1)}%).

Non-NULL note size in UTF-8 bytes: min ${sizes.min}, mean ${n(sizes.mean, 1)}, median ${sizes.p50}, p95 ${sizes.p95}, max ${sizes.max}. These describe the data only; ExportLite still uses fixed 256-row batches.

| Exporter | Compression | Total seconds | Min–max seconds | Output MiB | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
${results.map(({ method, compression, summary: s }) => `| ${names[method]} | ${modes[compression]} | ${seconds(s.durationMs)} | ${seconds(s.minDurationMs)}–${seconds(s.maxDurationMs)} | ${n(mib(s.bytes))} | ${n(s.peakRssMiB, 1)} |`).join("\n")}

- ExportLite uses ${change(plain.durationMs, get(report, "object-stream", "none").durationMs)} elapsed time without compression, ${change(fast.durationMs, get(report, "object-stream", "gzip-1").durationMs)} with level 1, and ${change(standard.durationMs, get(report, "object-stream", "gzip-default").durationMs)} with default gzip.
- For ExportLite, level 1 takes ${change(fast.durationMs, plain.durationMs)} elapsed time than no compression. Default gzip takes ${change(standard.durationMs, plain.durationMs)} elapsed time and ${change(standard.cpuMs, plain.cpuMs)} process CPU time than no compression.
- Default gzip takes ${change(standard.durationMs, fast.durationMs)} elapsed time than level 1 and produces ${change(standard.bytes, fast.bytes)} output. Encoded sizes match between exporters for every mode.

Compared with the earlier repeated-note fixture, the percentage of original bytes remaining is:

| Mode | Earlier repeated text | Varied business records |
| --- | ---: | ---: |
| Gzip level 1 | ${n(100 * oldFast.outputRatio, 1)}% | ${n(100 * fast.outputRatio, 1)}% |
| Default gzip | ${n(100 * oldDefault.outputRatio, 1)}% | ${n(100 * standard.outputRatio, 1)}% |

Raw observations, generator metadata, seed and sample records: [varied-compression-${kind}.json](results/varied-compression-${kind}.json).`;
});
const {
  environment: env,
  configuration: config,
  generatedAt,
} = reports[0].report;
const date = new Date(generatedAt).toLocaleDateString("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const text = `# ExportLite — varied-data gzip benchmark

Measured ${date}. These runs repeat the ExportLite versus JS object streaming comparison with no compression, gzip level 1 and default gzip, replacing the repeated note with seeded synthetic business records. Compression remains outside the core package; runtime source, API, compiled package and benchmark worker are unchanged.

## Data construction

The same four-column schema is retained: integer id, name, nullable note and integer active flag. Names include international characters and optional middle initials. Notes contain distinct seeded references, order/invoice amounts, dates, product descriptions, tracking URLs, synthetic email addresses, delivery instructions, quoted text and occasional newlines. Short notes are complete payment, invoice, order, return, delivery or follow-up messages; longer notes combine varied business/support clauses. Templates and categories still repeat, as they do in structured business records.

Seed: **${config.seed}**, with deterministic generation verified by rebuilding the fixture twice and comparing all rows. Width 32 selects short complete messages, with naturally varying lengths. Width 1024 selects longer notes with ordinary character lengths from 0.5 to 1.5 times that target. For large notes, independently selected 1% of non-NULL records have a further 4–12 times length multiplier. These are character targets, not byte caps; actual UTF-8 distributions appear below. Every seventh note is NULL; 72% of active flags are true in expectation. All data generation and distribution/cardinality queries happen before timing.

${sections.join("\n\n")}

## Interpretation and limits

Use these measurements to assess the relative cost of exporting and compressing this synthetic business workload. Distinct values alone do not imply incompressible data: field names, language, templates and categories repeat. This is more varied than the previous single-payload fixture, but it is not a production sample or a universal compression ratio.

Total time includes export planning, serialization, output/compressor creation, compression finalization and file close. These stages overlap with backpressure. Differences between compressed and uncompressed elapsed time are whole-pipeline effects, not isolated compression timings. Process CPU time, sampled heap and individual observations are available in the raw data. Small differences should be assessed against the min–max ranges.

The varied fixtures have different actual byte volumes and length distributions from the earlier constant-width Unicode fixtures. Compare compression by the percentage of original bytes remaining; do not interpret raw time changes between the two reports as a controlled measure of data entropy alone. Downloads, client decompression, concurrent exports, cold storage and expensive joins/sorts are not timed.

## Method and validation

- ${config.repeats} measured fresh-process runs plus ${config.warmups} warmup for each of six exporter/compression combinations and each dataset. Combination positions rotate; workers run sequentially. Fixture creation, driver/process startup and correctness checks are excluded from timing.
- ${env.cpu}; ${env.logicalCpus} logical CPUs; ${n(env.memoryGiB, 1)} GiB RAM; ${env.platform} ${env.release} ${env.architecture}; Node ${env.node}; better-sqlite3 ${env.driver}; SQLite ${env.sqlite}; bundled zlib ${env.zlib}. The latest driver version was checked before running; dependencies were not changed.
- Same ordered table scan and JSON fields for both exporters. ExportLite uses fixed 256-row SQLite JSON batches. JS object streaming iterates better-sqlite3 objects and uses JSON.stringify(). Both keep the same 64 KiB output target and yielding cadence as the prior comparison.
- Same benchmark worker, byte-counting Transform and file destination as before. Compression uses one continuous createGzip({ level: 1 }) or createGzip() stream, without per-batch resets or explicit flushes. Files are written to local temporary storage without fsync.
- Every combination first passed an independent 257-row parsed JSON comparison. Every warmup and timed output was checked after the worker finished: decompress when necessary, validate the gzip trailer, hash the entire decoded byte stream, compare raw byte counts and check encoded sizes against filesystem sizes. Verification is outside the timed process and does not inflate its reported memory.
- Peak RSS is the median of each process's absolute resident-memory high-water mark, including startup and native memory. It is not a per-batch memory allocation or a hard memory bound. Heap sampling is a lower bound. OS caches, scheduling and filesystem behavior affect timings.
- Earlier results are preserved in [the repeated-data report](COMPRESSION.md). Samples and measured note-size/cardinality statistics are included in each new raw JSON file.

## Reproduce

Build the package, then run:

\`\`\`sh
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/varied-compression-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,gzip-1,gzip-default --destinations=file --out=benchmarks/results/varied-compression-wide.json
node benchmarks/varied-report.mjs
\`\`\`
`;
await writeFile(new URL("./VARIED-COMPRESSION.md", import.meta.url), text);
console.log("Generated benchmarks/VARIED-COMPRESSION.md");
