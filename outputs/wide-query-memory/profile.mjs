import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${root}exportlite/package.json`);
const directory = fileURLToPath(new URL("./", import.meta.url));
const fixturePath = `${directory}wide.sqlite`;
if (process.argv[2] === "fixture") {
  const { createFixture } = await import(`${root}exportlite/benchmarks/fixture.mjs`);
  await mkdir(directory, { recursive: true });
  if (!existsSync(fixturePath)) {
    const info = createFixture(fixturePath, 15000, { width: 1024, profile: "varied", seed: 20261017 });
    console.log(JSON.stringify({ expectedJsonBytes: info.expectedJsonBytes, sqliteVersion: info.sqliteVersion }));
  }
  process.exit(0);
}

const [build, destination] = process.argv.slice(2);
assert.equal(process.version, "v26.12.0");
const api = await import(pathToFileURL(`${build}/index.mjs`));
const Database = require("better-sqlite3");
const db = new Database(fixturePath, { readonly: true });
const columns = { id: api.integer().primaryKey(), name: api.text(), note: api.text(), active: api.integer() };
const events = [];
const snapshots = [];
let peak = {};
let exportNumber = -1;
let writes = 0;
const observer = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) events.push({ exportNumber, kind: entry.detail.kind, startTime: entry.startTime, duration: entry.duration });
});
observer.observe({ entryTypes: ["gc"] });
function sample(label) {
  const memory = process.memoryUsage();
  for (const [key, value] of Object.entries(memory)) peak[key] = Math.max(peak[key] ?? 0, value);
  if (label) snapshots.push({ label, exportNumber, at: performance.now(), ...memory, spaces: getHeapSpaceStatistics() });
}
sample("start");
const times = [];
let expectedHash;
for (exportNumber = 0; exportNumber < 9; exportNumber++) {
  let bytes = 0;
  const hash = exportNumber === 0 ? createHash("sha256") : undefined;
  const output = new Writable({ write(chunk, _encoding, callback) {
    bytes += chunk.length;
    hash?.update(chunk);
    writes++;
    if (process.env.PROFILE_WRITES === "1") sample();
    callback();
  }});
  const started = performance.now();
  const stats = await api.exportQuery(db, { sql: "SELECT id,name,note,active FROM data ORDER BY id", columns, format: "json", output, end: true });
  times.push(performance.now() - started);
  assert.equal(bytes, 15094262);
  assert.equal(stats.bytesWritten, bytes);
  assert.equal(stats.rowsExported, 15000);
  if (hash) expectedHash = hash.digest("hex");
  sample(`export-${exportNumber}`);
}
await setImmediate();
sample("after-natural-runs");
const naturalEvents = [...events];
if (global.gc) {
  global.gc();
  await setImmediate();
  sample("after-diagnostic-GC");
}
observer.disconnect();
db.close();
await writeFile(destination, `${JSON.stringify({ node: process.version, build, sampleWrites: process.env.PROFILE_WRITES === "1", diagnosticGC: typeof global.gc === "function", times, writes, sha256: expectedHash, peak, peakRssMiB: process.resourceUsage().maxRSS / 1024, naturalEvents, snapshots }, null, 2)}\n`);
console.log(JSON.stringify({ destination, peak, gcCount: naturalEvents.length, gcMs: naturalEvents.reduce((sum, event) => sum + event.duration, 0) }));
