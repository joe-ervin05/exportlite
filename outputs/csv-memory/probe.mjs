import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as tick } from "node:timers/promises";

const require = createRequire(new URL("../../exportlite/package.json", import.meta.url));
const Database = require("better-sqlite3");
const allocations = { nativeBatches: 0, nativeBytes: 0, concatBuffers: 0, concatBytes: 0, encodedBuffers: 0, encodedBytes: 0, firstConcatStacks: [] };
const peaks = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
const snapshots = [];
function sample(label) {
  const memory = process.memoryUsage();
  for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], memory[key]);
  if (label) snapshots.push({ label, ...memory });
}
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (...args) {
  const statement = prepare.apply(this, args);
  const iterate = statement.iterate;
  const batches = args[0].startsWith('WITH RECURSIVE "__exportlite_batches"');
  statement.iterate = function* (...params) {
    let rows = 0;
    for (const row of iterate.apply(this, params)) {
      if (batches && Buffer.isBuffer(row[0])) {
        allocations.nativeBatches++;
        allocations.nativeBytes += row[0].length;
        sample();
      } else if (++rows % 64 === 0) sample();
      yield row;
    }
  };
  return statement;
};
const from = Buffer.from;
Buffer.from = function (...args) {
  const bytes = from.apply(this, args);
  if (typeof args[0] === "string" && bytes.length >= 4096) {
    allocations.encodedBuffers++;
    allocations.encodedBytes += bytes.length;
    sample();
  }
  return bytes;
};
const concat = Buffer.concat;
Buffer.concat = function (...args) {
  const bytes = concat.apply(this, args);
  if (bytes.length >= 4096) {
    allocations.concatBuffers++;
    allocations.concatBytes += bytes.length;
    if (allocations.firstConcatStacks.length < 2) allocations.firstConcatStacks.push(new Error().stack);
    sample();
  }
  return bytes;
};
const gc = { count: 0, durationMs: 0, kinds: {} };
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.count++; gc.durationMs += entry.duration;
    const kind = entry.detail.kind;
    gc.kinds[kind] = (gc.kinds[kind] ?? 0) + 1;
  }
  sample();
});
observer.observe({ entryTypes: ["gc"] });
sample("start");
const interval = setInterval(() => sample(), 5);
interval.unref();
process.once("beforeExit", async () => {
  clearInterval(interval);
  sample("end-natural");
  await tick();
  const naturalGc = structuredClone(gc);
  if (global.gc) {
    for (let i = 0; i < 3; i++) { global.gc(); await tick(); }
    sample("end-after-diagnostic-gc");
  }
  observer.disconnect();
  writeFileSync(process.env.PROFILE_OUT, `${JSON.stringify({ node: process.version, allocations, peaks, snapshots, naturalGc, gcIncludingDiagnostic: gc, maxRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2)}\n`);
});
