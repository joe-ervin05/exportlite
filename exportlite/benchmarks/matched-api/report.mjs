import { readFile, writeFile } from "node:fs/promises";

const resultUrl = new URL(
  "../results/matched-api/summary.json",
  import.meta.url,
);
const summary = JSON.parse(await readFile(resultUrl, "utf8"));
const old = JSON.parse(
  await readFile(new URL("./reference/summary.json", import.meta.url), "utf8"),
);
const methods = ["sqlite", "exportlite", "manual", "drizzle"];
const labels = {
  sqlite: "Full SQLite aggregate",
  exportlite: "ExportLite · 256-root batches",
  manual: "Manual JS + stringify",
  drizzle: "Drizzle + stringify",
  "exportlite-rows": "ExportLite · row fallback",
  "public-table-256": "Public table → Node writable",
  "public-web-table": "Public table → Web stream",
};
const depths = ["Users", "Users → posts", "Users → posts → comments"];
const f = (n) => (n == null ? "—" : n < 1 ? n.toFixed(4) : n.toFixed(2));
const flat = summary.cases.find(
  (row) => row.roots === 1_000_000 && row.depth === 0,
).methods;
const large = summary.cases.filter((row) => row.roots === 1_000_000);
const encodingShares = large.flatMap((row) =>
  methods.map(
    (method) =>
      (100 * row.methods[method].encodingMs) / row.methods[method].totalMs,
  ),
);
const lines = [
  "# Matched JSON generation and response encoding",
  "",
  "Measured October 17, 2026. All four methods use the original fixture, Node **26.12.0**, SQLite **3.53.4**, better-sqlite3 **13.0.3**, and Drizzle **0.45.4**. These are response-production timings through UTF-8 bytes in memory, with no compression, disk or network transfer.",
  "",
  `Completed **${summary.workers} fresh workers** across all **${summary.cases.length} original cases** and the additional controls. Every worker's complete validation output matches the original JSON SHA-256 digest. Timed response byte counts also match.`,
  "",
  "## Findings",
  "",
  `- On the matched million-user flat fixture, full aggregation is ${(flat.drizzle.totalMs / flat.sqlite.totalMs).toFixed(2)}× as fast as Drizzle; ExportLite batching is ${(flat.drizzle.totalMs / flat.exportlite.totalMs).toFixed(2)}× as fast. The complete aggregate and streaming batches remain different algorithms even after matching the dataset and runtime.`,
  `- UTF-8 encoding is ${Math.min(...encodingShares).toFixed(1)}–${Math.max(...encodingShares).toFixed(1)}% of total time across the main million-root comparisons. It is not the principal explanation for their throughput differences on this ASCII fixture.`,
  `- Actual public Web-stream table export takes ${f(flat["public-web-table"].totalMs)} ms for the same million flat users. The row-streaming producer takes ${f(flat["exportlite-rows"].totalMs)} ms, versus ${f(flat.manual.totalMs)} ms for manual all()+stringify. Streaming alone does not guarantee a speed win; the batch path matters.`,
  "- Full aggregation retains the whole response before encoding. ExportLite keeps its existing batch/writable flow and lower retained memory. Peak-RSS columns include module startup, verification and warmups, so they describe whole worker processes rather than per-request allocations.",
  "- These changes add benchmark tooling only. Nested batching and limited-root projections are benchmark adapters around the actual planner/producer, not new public API features.",
  "",
  "## One million root users",
  "",
  "All times are milliseconds. Generation includes the real producer/writable coordination; encoding is the measured UTF-8 conversion. Components come from the same median-total observations, so they add to total before rounding.",
  "",
];
for (const depth of [0, 1, 2]) {
  const row = summary.cases.find(
    (r) => r.roots === 1_000_000 && r.depth === depth,
  );
  lines.push(
    `### ${depths[depth]}`,
    "",
    `${row.totalRecords.toLocaleString("en-US")} total records; ${(row.bytes / 1_048_576).toFixed(2)} MiB JSON.`,
    "",
    "| Method | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms | Peak RSS MiB |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const method of methods) {
    const r = row.methods[method];
    lines.push(
      `| ${labels[method]} | ${f(r.generationMs)} | ${f(r.encodingMs)} | ${f(r.totalMs)} | ${f(r.minMs)}–${f(r.maxMs)} | ${f(r.peakRssMiB)} |`,
    );
  }
  const r = row.methods;
  lines.push(
    "",
    `On this shape, the full aggregate is ${(r.drizzle.totalMs / r.sqlite.totalMs).toFixed(2)}× as fast as Drizzle and ${(r.manual.totalMs / r.sqlite.totalMs).toFixed(2)}× as fast as manual JS. ExportLite batching is ${(r.drizzle.totalMs / r.exportlite.totalMs).toFixed(2)}× as fast as Drizzle and ${(r.manual.totalMs / r.exportlite.totalMs).toFixed(2)}× as fast as manual JS, and takes ${(100 * (r.exportlite.totalMs / r.sqlite.totalMs - 1)).toFixed(1)}% more time than full aggregation.`,
    "",
  );
}
lines.push(
  "## Public API and fallback controls",
  "",
  "| Shape at 1m roots | Control | Generation/pipeline ms | UTF-8 ms | Total ms | Total min–max ms |",
  "| --- | --- | ---: | ---: | ---: | ---: |",
);
for (const row of summary.cases.filter((r) => r.roots === 1_000_000))
  for (const method of [
    "exportlite-rows",
    "public-table-256",
    "public-web-table",
  ]) {
    const r = row.methods[method];
    if (r)
      lines.push(
        `| ${depths[row.depth]} | ${labels[method]} | ${f(r.generationMs)} | ${f(r.encodingMs)} | ${f(r.totalMs)} | ${f(r.minMs)}–${f(r.maxMs)} |`,
      );
  }
lines.push(
  "",
  "The public controls include validation/planning. The Web stream control is total-only; native stream conversion cannot be separated with this string-sink instrument. Nested cases use a benchmark-only projection adapter around the existing planner/producer. They do not claim public nested-query support.",
  "",
  "## Original chart versus this run",
  "",
  "| 1m-root shape | Original full SQLite generation ms | Current full SQLite generation/pipeline ms | Original Drizzle/SQLite ratio | Current Drizzle/SQLite total ratio | Current Drizzle/ExportLite total ratio |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const row of summary.cases.filter((r) => r.roots === 1_000_000)) {
  const previous = old.cases.find(
    (r) => r.roots === row.roots && r.depth === row.depth,
  );
  const sqlite = previous.methods.revised_sql_direct.median_ms;
  lines.push(
    `| ${depths[row.depth]} | ${f(sqlite)} | ${f(row.methods.sqlite.generationMs)} | ${(previous.methods.drizzle_relational_stringify.median_ms / sqlite).toFixed(2)}× | ${(row.methods.drizzle.totalMs / row.methods.sqlite.totalMs).toFixed(2)}× | ${(row.methods.drizzle.totalMs / row.methods.exportlite.totalMs).toFixed(2)}× |`,
  );
}
lines.push(
  "",
  "This keeps runtime, fixture values, selected fields, relationships, ordering and baseline implementations matched. The original chart stopped at a JavaScript JSON string; this run additionally allocates UTF-8 response bytes. The current complete-aggregate baseline and the streaming exporter remain different algorithms. Phase timing is an accounting split within the full response pipeline; allocations and GC can affect later phases.",
  "",
  "## All 21 cases",
  "",
  "Times are `generation/pipeline + UTF-8 = total` in milliseconds. All four methods produce the same bytes within each case.",
  "",
  "| Roots | Shape | Full SQLite | ExportLite batches | Manual JS | Drizzle |",
  "| ---: | --- | ---: | ---: | ---: | ---: |",
);
for (const row of summary.cases)
  lines.push(
    `| ${row.roots.toLocaleString("en-US")} | ${depths[row.depth]} | ${methods
      .map((method) => {
        const r = row.methods[method];
        return `${f(r.generationMs)} + ${f(r.encodingMs)} = **${f(r.totalMs)}**`;
      })
      .join(" | ")} |`,
  );
lines.push(
  "",
  "## Method and limits",
  "",
  "Main comparisons use prepared queries and three fresh processes per method/case, with rotating order, warm repeated reads, natural GC, no explicit collection and no raised heap limit. Each process reports its median batch mean; min/max show process variation. SQL construction/preparation, process startup, fixture generation, sink construction and correctness hashing are excluded. Actual public API controls include their normal planning.",
  "",
  'Generation/pipeline includes SQLite/driver work, mapping/stringification when needed, and completion of the shared writable. ExportLite retains real batch stitching, byte-length scans, cancellation checks and event-loop yields. Encoding sums synchronous `Buffer.from(chunk, "utf8")` intervals, including allocation. Complete-value methods encode one whole string; ExportLite encodes normal buffered chunks. The sink discards bytes; HTTP headers/framing, tRPC envelopes, socket backpressure, TLS, transfer, client parsing and compression are outside these measurements. This is not an end-to-end HTTP server benchmark.',
  "",
  "Peak RSS includes process startup, unmeasured validation and warmups, so it is not a per-response or per-phase memory reading. All methods load the same benchmark modules. The original short ASCII fixture isolates structure/record overhead; it does not replace the separate varied/Unicode export datasets. Small absolute differences must be read against the process ranges. These results apply to this machine and workload.",
  "",
  `Environment: ${summary.environment.platform}; ${summary.environment.cpu}; Node ${summary.environment.node}; V8 ${summary.environment.v8}.`,
  "",
  `Fixture SHA-256: \`${summary.configuration.fixtureSha256}\`. Harness fingerprint: \`${summary.fingerprint}\`.`,
  "",
  "[Reproduction and adapter details](matched-api/README.md). [CSV](results/matched-api/results.csv). [Summary](results/matched-api/summary.json). [Configuration/source hashes](results/matched-api/configuration.json). [Raw workers](results/matched-api/raw/).",
  "",
);
await writeFile(
  new URL("../MATCHED-API.md", import.meta.url),
  lines.join("\n"),
);
console.log("Wrote benchmarks/MATCHED-API.md");
