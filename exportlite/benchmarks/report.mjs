import { readFile, writeFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./results/${name}.json`, import.meta.url), "utf8"),
  );
const [narrow, wide] = await Promise.all([load("v0-narrow"), load("v0-wide")]);
const names = {
  exportlite: "ExportLite table (256 rows)",
  "exportlite-query": "ExportLite query (row streaming)",
  "object-stream": "JS object streaming",
  "raw-stream": "JS raw-array streaming",
  "naive-all": "Fetch all + JSON.stringify",
  "sqlite-cli": "SQLite CLI JSON",
  "sqlite-aggregate": "SQLite full-array aggregation",
};
const n = (value) => (value === null ? "—" : value.toFixed(1));
const table = (
  report,
) => `| Method | Median ms | Min–max ms | Peak RSS MiB | Sampled heap MiB | First record ms | Max timer delay ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${report.results.map(({ method, summary: s }) => `| ${names[method] ?? method} | ${n(s.durationMs)} | ${n(s.minDurationMs)}–${n(s.maxDurationMs)} | ${n(s.peakRssMiB)} | ${n(s.sampledPeakHeapMiB)} | ${n(s.firstRecordMs)} | ${n(s.maxEventLoopDelayMs)} |`).join("\n")}`;
const env = narrow.environment;
const date = new Date(narrow.generatedAt).toLocaleDateString("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const text = `# ExportLite v0 — fixed batching benchmark

Measured ${date}. These results use the simplified v0 API: table batches are fixed internally at 256 rows, custom queries stream individual records, and there are no public batch-sizing controls or SQL callbacks.

## One million small records, file destination

The nullable TEXT payload is 32 characters and includes Unicode, quotes and LF. Each record also has an integer primary key, short name and integer flag.

${table(narrow)}

## 100,000 large records, file destination

The same schema uses a 1,024-character payload instead. Fixed batching limits row count, not output bytes or process memory.

${table(wide)}

## Validation and interpretation

All four implementations passed an independent 257-row parsed JSON equivalence check before timing; large timed runs checked row counts. Table batching executes one recursive data statement using indexed rowid ranges, with a key scan followed by payload aggregation per batch. Queries use one streaming data statement. Schema/probe queries remain separate. Integration tests validate views, virtual tables, WITHOUT ROWID and shadowed-rowid fallbacks, but the timed fixtures are ordinary rowid tables.

The full-array baseline builds the entire result in SQLite before transferring it to JavaScript. Its first-record latency and peak memory therefore cover the whole JSON array. JS object streaming iterates driver row objects and JSON.stringify()s each one. These simple table scans have matching output order in the fixture; no general ordering guarantee is inferred for arbitrary aggregate SQL. Performance measurements use JSON arrays; JSONL has correctness coverage.

## Environment and method

- ${env.cpu}; ${env.logicalCpus} logical CPUs; ${n(env.memoryGiB)} GiB system RAM.
- ${env.platform} ${env.release} ${env.architecture}; Node ${env.node}; better-sqlite3 ${env.driver}; SQLite ${env.sqlite}.
- Three measured runs and one separate warmup per case, each in a fresh process. Method order rotates. Warmups mostly prewarm OS caches, not the measured process's JIT.
- Fixture creation and process/driver startup are outside the timer. Planning and destination completion are included. Files use local temporary storage without fsync.
- Node paths use the same 64 KiB output target and yield after at least 2,048 rows. Batched output yields at batch boundaries.
- Tables show medians of individual run metrics, with duration ranges. RSS is the absolute process high-water mark, including startup; it is not the memory size of one batch. Heap sampling is a lower bound.
- First-record time is measured when completed sink callbacks cover the first record. Timer delay is the maximum lateness of a 1 ms interval, with a short settlement period after completion. Scheduling and filesystem caching add noise.
- These cases validate a small prototype on one machine; they do not establish a universal speed advantage, an absolute memory ceiling or relational performance.

Raw observations: [Small records](results/v0-narrow.json), [Large records](results/v0-wide.json). Reproduction commands are in the package README. Earlier experiments are preserved separately from this simplified working package.
`;
await writeFile(new URL("./REPORT.md", import.meta.url), text);
console.log("Generated benchmarks/REPORT.md");
