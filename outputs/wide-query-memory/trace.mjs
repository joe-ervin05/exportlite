import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.version, "v26.12.0");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const [before, after, destination = here] = process.argv.slice(2);
assert(before && after, "Pass phase 2 and candidate dist directories.");
const setup = spawnSync(process.execPath, [join(here, "profile.mjs"), "fixture"], { encoding: "utf8" });
assert.equal(setup.status, 0, setup.stderr);
const fixture = { name: "wide", rows: 15000, width: 1024, profile: "varied", iterations: 2,
  web: false, path: join(here, "wide.sqlite"), expectedJsonBytes: 15094262 };
const fields = ["gc", "pause", "allocated", "promoted", "start_object_size", "end_object_size",
  "start_memory_size", "end_memory_size", "new_space_capacity", "reason"];
const records = [];
await mkdir(destination, { recursive: true });
for (let round = 0; round < 3; round++) {
  const builds = [["current", before], ["encode-before-send", after]];
  for (const [variant, build] of round % 2 ? builds.toReversed() : builds) {
    const child = spawnSync(process.execPath, ["--trace-gc-nvp", join(root, "outputs/phase2/compare.mjs"),
      "worker", "after", JSON.stringify(fixture), "query", "false"], {
      env: { ...process.env, EXPORTLITE_AFTER: resolve(build) }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    // Node 26 emits JSON GC records. A final GC can follow the worker result.
    const events = child.stdout.split("\n").filter(line => line.includes("GC: {"))
      .map(line => JSON.parse(line.slice(line.indexOf("GC: ") + 4)))
      .map(event => Object.fromEntries(fields.filter(key => key in event).map(key => [key, event[key]])));
    const marker = child.stdout.indexOf('{"variant"');
    const line = child.stdout.slice(marker).split("\n")[0];
    // The worker writes no trailing newline; trace output can start on that line.
    let end = line.length;
    let measurement;
    while (end > 0) {
      try { measurement = JSON.parse(line.slice(0, end)); break; }
      catch { end = line.lastIndexOf("}", end - 2) + 1; }
    }
    assert(measurement && events.length > 0);
    assert.equal(measurement.sha256, "f598791466249d06db150352ab3df936ecd19d85fe77825a448ee26c95b3c523");
    const totals = {
      collections: events.length, majorCollections: events.filter(event => event.gc === "mc").length,
      allocatedBytes: events.reduce((sum, event) => sum + (event.allocated ?? 0), 0),
      promotedBytes: events.reduce((sum, event) => sum + (event.promoted ?? 0), 0),
      maxHeapCapacityBytes: Math.max(...events.map(event => event.start_memory_size)),
      maxHeapObjectsBytes: Math.max(...events.map(event => event.start_object_size)),
    };
    records.push({ variant, round, measurement, events, totals });
    console.error(`${variant} round ${round + 1}: ${measurement.peakRssMiB.toFixed(1)} MiB peak RSS`);
  }
}
await writeFile(join(destination, "gc-traces.json"), `${JSON.stringify(records, null, 2)}\n`);
