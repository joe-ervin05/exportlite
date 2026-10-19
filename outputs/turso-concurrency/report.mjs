import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = process.argv.includes("--smoke") ? "smoke" : "comparison";
const config = JSON.parse(readFileSync(`${directory}${run}/configuration.json`));
const validation = JSON.parse(readFileSync(`${directory}${run}/validation.json`));
assert(validation.passed);
const all = JSON.parse(readFileSync(`${directory}${run}/all.json`));
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, p) => sorted(xs)[Math.max(0, Math.ceil(xs.length * p) - 1)];
const median = (xs) => quantile(xs, 0.5);
const groups = new Map();
for (const r of all) {
  const key = JSON.stringify([r.name, r.method, r.policy, r.concurrency, r.latencyMs]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const summary = [];
for (const rows of groups.values()) {
  assert.equal(rows.length, config.rounds);
  const r = rows[0];
  const f = config.fixtures.cases.find((f) => f.name === r.name);
  const latencies = rows.flatMap((r) => r.waves.flatMap((w) => w.exports.map((e) => e.totalMs)));
  const rates = rows.map((r) => r.exportsPerSecond);
  const peaks = rows.map((r) => r.peakRssMiB);
  summary.push({
    name: r.name, method: r.method, policy: r.policy, concurrency: r.concurrency, latencyMs: r.latencyMs,
    workers: rows.length, timedWaves: rows.reduce((n, r) => n + r.waves.length, 0), timedExports: latencies.length,
    exportsPerSecond: median(rates), minExportsPerSecond: Math.min(...rates), maxExportsPerSecond: Math.max(...rates),
    outputMiBPerSecond: median(rates) * f.expected.bytes / 2 ** 20,
    meanLatencyMs: latencies.reduce((n, v) => n + v, 0) / latencies.length,
    p50LatencyMs: median(latencies), p95LatencyMs: quantile(latencies, 0.95), maxLatencyMs: Math.max(...latencies),
    medianWaveMs: median(rows.flatMap((r) => r.waves.map((w) => w.totalMs))),
    medianPeakRssMiB: median(peaks), maxPeakRssMiB: Math.max(...peaks), minPeakRssMiB: Math.min(...peaks),
    initialRssMiB: median(rows.map((r) => r.initialMemory.rss / 2 ** 20)),
    shutdownMs: median(rows.map((r) => r.shutdownMs)),
    maxActiveCursors: Math.max(...rows.map((r) => r.server.maxActiveCursors)),
    outputBytes: f.expected.bytes, sha256: f.expected.sha256,
  });
}
summary.sort((a, b) => a.name.localeCompare(b.name) || a.latencyMs - b.latencyMs || a.method.localeCompare(b.method) || a.concurrency - b.concurrency || a.policy.localeCompare(b.policy));
writeFileSync(`${directory}${run}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
const keys = Object.keys(summary[0]);
writeFileSync(`${directory}${run}/summary.csv`, keys.join(",") + "\n" + summary.map((r) => keys.map((k) => r[k]).join(",")).join("\n") + "\n");
if (run === "smoke") process.exit(0);
const get = (name, method, policy, concurrency, latencyMs) => {
  const row = summary.find((r) => r.name === name && r.method === method && r.policy === policy && r.concurrency === concurrency && r.latencyMs === latencyMs);
  assert(row); return row;
};
const fixed = (x, digits = 1) => x.toFixed(digits);
const methodName = (x) => x === "direct" ? "Direct" : "Drizzle adapter";
const label = (x) => ({ "table-1": "1 row", "table-10": "10 rows", "table-1000": "1,000 rows", "narrow-plain": "1M narrow", "wide-plain": "100K wide" })[x];
const main = [];
for (const f of config.fixtures.cases)
  for (const method of config.methods)
    for (const policy of ["shared", "separate"]) {
      const r = get(f.name, method, policy, 4, 100);
      main.push(`| ${label(f.name)} | ${methodName(method)} | ${policy} | ${fixed(r.exportsPerSecond, 2)} | ${fixed(r.meanLatencyMs)} | ${fixed(r.p95LatencyMs)} | ${fixed(r.maxPeakRssMiB)} |`);
    }
const scales = [];
for (const f of config.fixtures.cases)
  for (const latency of config.latencies) {
    const row = [label(f.name), latency];
    for (const setting of config.settings) row.push(fixed(get(f.name, "direct", setting.policy, setting.concurrency, latency).exportsPerSecond, 2));
    scales.push(`| ${row.join(" | ")} |`);
  }
const ratios = [];
for (const f of config.fixtures.cases)
  for (const method of config.methods) {
    const s = get(f.name, method, "shared", 4, 100);
    const p = get(f.name, method, "separate", 4, 100);
    ratios.push(`| ${label(f.name)} | ${methodName(method)} | ${fixed(p.exportsPerSecond / s.exportsPerSecond, 2)}× | ${fixed(p.meanLatencyMs / s.meanLatencyMs, 2)}× | ${fixed(p.maxPeakRssMiB - s.maxPeakRssMiB)} |`);
  }
const headlineRatios = ["table-1000", "narrow-plain", "wide-plain"].map((name) => {
  const shared = get(name, "direct", "shared", 4, 100);
  const separate = get(name, "direct", "separate", 4, 100);
  return fixed(separate.exportsPerSecond / shared.exportsPerSecond, 2);
});
const text = `# Concurrent Turso exports: shared versus separate clients

Measured ${config.date.slice(0, 10)} with the existing ExportLite session-reuse implementation. This changes the benchmark only. Package source, compiled output, dependency lockfile, fixture databases and exact Node binary match the preceding session-reuse run.

At 100 ms added latency, four separate clients improve direct-API throughput by **${headlineRatios[0]}× for 1,000 rows, ${headlineRatios[1]}× for 1M narrow rows and ${headlineRatios[2]}× for 100K wide rows** versus one shared client. The shared session queue exposes network wait for each export in succession. Separate clients overlap that wait; large exports still share this simulator's single-threaded generation capacity. These are local measurements, not a Turso Cloud scaling result.

## Four simultaneous exports, 100 ms added latency

Each wave submits four exports at once. **Shared** uses one reusable client/session and its existing export queue; **separate** uses four clients/sessions in the same client process against the same server/database. Clients persist across warmup and timed waves. Throughput is exports completed per second of wave wall time. Latency includes queue wait and full output consumption.

Rates are medians of three fresh workers. Mean and p95 latency pool all 24 timed exports per row (six waves). Peak memory is the **highest whole-client-process RSS observed across those workers**, including imports, verification/warmup, simultaneous streams, natural GC and shutdown; database server and coordinator are separate processes and excluded. MiB = 2^20 bytes.

| Fixture | API | Clients | Exports/s | Mean export ms | p95 export ms | Peak RSS MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
${main.join("\n")}

### Separate/shared ratios at concurrency four, 100 ms

Throughput above 1 is better. Latency below 1 is better. Memory is separate minus shared, using the highest measured RSS for each setting.

| Fixture | API | Throughput ratio | Mean latency ratio | Peak RSS difference MiB |
| --- | --- | ---: | ---: | ---: |
${ratios.join("\n")}

## Scaling and latency sensitivity

Direct API exports/s. Concurrency one is a common single-client control, since both policies are identical there. The complete direct/Drizzle matrix, latency statistics, worker ranges and both median/highest memory are in the [summary CSV](../../outputs/turso-concurrency/comparison/summary.csv).

| Fixture | Added latency ms | C1 | C2 shared | C2 separate | C4 shared | C4 separate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${scales.join("\n")}

## Method and validation

- Exact Node **26.12.0**, binary SHA-256 \`${config.nodeSha256}\`; SQLite **3.53.4**, better-sqlite3 **13.0.3**, @libsql/client **0.18.0**, Drizzle **0.45.4**. Latest npm metadata was checked on October 18; matched versions were retained. Hardware: ${config.cpu}, ${fixed(config.totalMemoryGiB, 0)} GiB RAM.
- The same five varied fixtures as [the previous comparison](TURSO-SESSIONS.md): 1, 10 and 1,000 rows; 1,000,000 narrow rows producing 83,369,847 bytes (79.51 MiB); 100,000 wide rows producing 100,920,480 bytes (96.25 MiB). Original fixture database/output hashes are recorded in configuration.
- **${validation.workers} fresh client workers**, run sequentially with rotated policy/API order. Three workers per fixture/API/latency/setting. Each runs a full-concurrency verification wave that warms every client/session, then two timed waves: **${validation.timedExports} timed exports**, plus **${validation.hashVerifiedExports} hash-verified warmup exports**. Every export checks byte length and exported row count; each lane's verification checks its entire output SHA-256.
- Each worker has one fresh separate HTTP/SQLite server process. Shared and separate clients both use that one endpoint and database. The server is copied from the preceding benchmark with request-start/end and maximum-overlap counters added; its data path is unchanged. No extra servers or database CPU are allocated to the separate policy.
- Server traces assert one SQL SELECT and one cursor HTTP request per export, fixed 256-row batches, no preflight queries, one opened/reused session per client, shared-client maximum overlap of one, full separate-client overlap at 100 ms, one close request per client and zero sessions after awaited shutdown. Package/build/harness and fixture fingerprints match before/after. No package implementation edits were made.
- Latency is fixed at 0, 25 or 100 ms once per HTTP request before response; it is never applied per SQLite batch or row. Healthy cached sessions are reused, with no simulated expiry/failure in the timed matrix.
- Per-export timers start at submission before the client queue can be acquired, and stop after all bytes are consumed. Small outputs use the existing Web stream plus Response.arrayBuffer; bulk drains to the same counting Node writable with immediate callbacks. Imports, client/schema/Drizzle initialization and server startup are excluded from timing. Default 256-row batching and 64 KiB buffering are unchanged.
- Client close is awaited concurrently after all waves and excluded from export times. Separate clients each send one close request, while a shared client sends one. Shutdown time and memory are recorded. No forced GC, compression, output files, application HTTP download, TLS, jitter, loss or bandwidth cap.

## Interpretation limits

These are **burst waves**, not a continuous-load capacity test: each wave waits for its slowest export before starting the next. The shared queue completes work successively; separate clients overlap their requests but compete for resources. A throughput gain does not guarantee lower individual latency under contention. p95 is a descriptive nearest-rank sample statistic (24 requests at C4, 12 at C2, six at C1), not a production tail-latency estimate.

The fixture server runs real read-only SQLite and JSON protocol framing on **one JavaScript event loop and one native SQLite connection**. At zero added latency, traces show some large separate-client responses are served successively; at nonzero latency the request waits overlap. Synchronous SQLite generation and protocol serialization share that server's CPU capacity. The client also has one event loop for all streams. This limits large-export parallelism; different Turso server hardware, concurrency scheduling and actual network bandwidth can produce different results. No live Turso Cloud performance or compatibility has been verified. Peak RSS is process-level high-water usage with natural GC; it is not a per-stream allocation estimate or a guaranteed memory ceiling. Drizzle runtime imports contribute to its process baseline.

Only homogeneous fast-consumer waves were measured. Mixed export sizes, slow destinations, long-running continuous arrivals, session expiry and cancellation remain outside this timing matrix. Existing backpressure, cancellation and cleanup code is unchanged.

## Reproduce and artifacts

Run from the workspace root with the exact Node binary recorded in configuration (localhost binding permission required). Existing result directories are protected from overwrite.

\`\`\`sh
/path/to/node-26.12.0 outputs/turso-concurrency/run.mjs
/path/to/node-26.12.0 outputs/turso-concurrency/report.mjs
\`\`\`

To repeat a run, rename the existing comparison/ directory first; measurements are never overwritten. Add --smoke for the 18-worker validation matrix, and to report.mjs to summarize that run separately (rename smoke/ first when repeating it).

- [Summary CSV](../../outputs/turso-concurrency/comparison/summary.csv), [summary JSON](../../outputs/turso-concurrency/comparison/summary.json)
- [Raw workers and request traces](../../outputs/turso-concurrency/comparison/all.json)
- [Configuration and fingerprints](../../outputs/turso-concurrency/comparison/configuration.json), [validation](../../outputs/turso-concurrency/comparison/validation.json), [matched-runtime/package evidence](../../outputs/turso-concurrency/compatibility.json)
- [Runner](../../outputs/turso-concurrency/run.mjs), [worker](../../outputs/turso-concurrency/worker.mjs), [server](../../outputs/turso-concurrency/server.mjs), [report generator](../../outputs/turso-concurrency/report.mjs)
`;
writeFileSync(`${root}exportlite/benchmarks/TURSO-CONCURRENCY.md`, text);
console.log(`Wrote ${summary.length} settings and TURSO-CONCURRENCY.md`);
