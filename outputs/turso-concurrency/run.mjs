import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = fileURLToPath(new URL(".", import.meta.url));
const node = "<node-26.12.0>";
assert.equal(process.version, "v26.12.0");
const fixtures = JSON.parse(readFileSync(`${directory}fixtures.json`));
const methods = ["direct", "drizzle"];
const latencies = [0, 25, 100];
const settings = [
  { policy: "shared", concurrency: 1 },
  { policy: "shared", concurrency: 2 },
  { policy: "separate", concurrency: 2 },
  { policy: "shared", concurrency: 4 },
  { policy: "separate", concurrency: 4 },
];
const smoke = process.argv.includes("--smoke");
const rounds = smoke ? 1 : 3;
const output = `${directory}${smoke ? "smoke" : "comparison"}/`;
assert(!existsSync(`${output}all.json`), "Keep existing measurements; use a fresh output directory");
mkdirSync(`${output}raw`, { recursive: true });
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const f of fixtures.cases) assert.equal(digest(f.path), f.fixtureSha256);
const tracked = ["exportlite/package.json", "exportlite/pnpm-lock.yaml", ...["server.mjs", "worker.mjs", "run.mjs", "fixtures.json"].map((p) => `outputs/turso-concurrency/${p}`)];
for (const dir of ["exportlite/src", "exportlite/dist"]) {
  const visit = (path) => {
    for (const entry of readdirSync(root + path, { withFileTypes: true })) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(next); else tracked.push(next);
    }
  };
  visit(dir);
}
const fingerprints = Object.fromEntries(tracked.map((p) => [p, digest(root + p)]));
const jobs = [];
for (let round = 0; round < rounds; round++)
  for (const [fi, f] of fixtures.cases.entries())
    for (const [li, latency] of latencies.entries()) {
      if (smoke && !((f.name === "table-1" && latency === 100) || (["narrow-plain", "wide-plain"].includes(f.name) && latency === 0))) continue;
      const offset = (round + fi + li) % settings.length;
      for (const setting of [...settings.slice(offset), ...settings.slice(0, offset)]) {
        if (smoke && setting.concurrency === 2) continue;
        const order = (round + fi + li) % 2 ? [...methods].reverse() : methods;
        for (const method of order) jobs.push({ name: f.name, method, ...setting, latency, round });
      }
    }
const configuration = {
  date: new Date().toISOString(), node, nodeSha256: digest(node), cpu: cpus()[0].model,
  totalMemoryGiB: totalmem() / 2 ** 30, loadavg: loadavg(), fixtures, methods, latencies,
  settings, rounds, jobs, fingerprints,
  versionsChecked: { date: "2026-10-18", "@libsql/client": "0.18.0", "drizzle-orm": "0.45.4", "better-sqlite3": "13.0.3", source: "npm registry latest metadata; matched pinned versions retained" },
  methodology: "Three fresh client workers per setting, run sequentially with method/policy order rotated. Each worker and all its clients share one fresh HTTP/SQLite server process and database, identical to the preceding session benchmark except request-overlap instrumentation. One native database connection and one JS server event loop; server serialization/SQLite CPU and local loopback bandwidth constrain concurrent throughput. A single full-concurrency SHA-256 verification wave warms every client/session; two timed waves then launch C exports together and await all completions. Policies are one shared client or C clients, one per lane; clients persist across waves. C=1 is a common control. Timers start on submission, include shared-client queue wait and full drain, exclude imports/client setup/server startup and shutdown. Throughput is completed exports / summed timed wave makespans; this is a burst-wave comparison, not a continuous-load capacity test. Small outputs use Response.arrayBuffer; bulk uses counting writable with synchronous callbacks. Fixed 256-row batches/64KiB buffering unchanged. Peak RSS covers the complete client process including imports, warmup, all simultaneous clients, timed waves, natural GC and awaited shutdown; server/coordinator excluded. No forced GC, ZIP, disk output, download HTTP, TLS, bandwidth cap, jitter or packet loss. Latency added once per HTTP request before response, never per row or batch. A reused healthy export sends one cursor request and one SQL SELECT; each client sends one close request at shutdown, measured separately and concurrently. Local protocol simulation, no live Turso Cloud verification.",
};
writeFileSync(`${output}configuration.json`, JSON.stringify(configuration, null, 2) + "\n");
const all = [];
for (const [ji, job] of jobs.entries()) {
  const f = fixtures.cases.find((f) => f.name === job.name);
  const stem = `${job.name}-${job.method}-${job.policy}-c${job.concurrency}-lat${job.latency}-r${job.round}`;
  const server = spawn(node, [`${directory}server.mjs`, f.path, String(job.latency)], { cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  try {
    const ready = await message(server, "ready");
    assert.equal(ready.sqlite, "3.53.4");
    assert.equal(ready.driver, "13.0.3");
    const file = `${output}raw/${stem}.json`;
    const child = spawn(node, [`${directory}worker.mjs`, job.name, job.method, job.policy, String(job.concurrency), ready.url, String(job.latency), file, smoke ? "1" : ""], { cwd: root, stdio: "inherit" });
    await exited(child);
    const result = JSON.parse(readFileSync(file));
    const id = randomUUID();
    const pending = message(server, "stats", id);
    server.send({ type: "stats", id });
    const stats = await pending;
    assert.equal(stats.active, 0);
    assert.equal(stats.sessions, 0);
    assert.equal(stats.activeCursors, 0);
    assert(stats.records.every((r) => !r.error), "Server error");
    assert.equal(stats.records.length, result.requests + result.clients);
    assert.equal(stats.records.flatMap((r) => r.sql).length, result.requests);
    assert(stats.records.flatMap((r) => r.sql).every((sql) => !/pragma|sqlite_version|sqlite_schema/i.test(sql)), "Unexpected preflight");
    assert.equal(stats.openedSessions, result.clients);
    assert.equal(stats.maxSessions, result.clients);
    assert.equal(stats.reusedRequests, result.requests - result.clients);
    assert.equal(stats.records.filter((r) => r.path === "/v3/pipeline").length, result.clients);
    assert(stats.records.filter((r) => r.path === "/v3/pipeline").every((r) => r.sql.length === 0 && r.requestTypes.join(",") === "close"));
    assert(stats.records.filter((r) => r.path === "/v3/cursor").every((r) => r.sql.length === 1 && r.batchRows === f.rows && r.batches === Math.ceil(f.rows / 256)));
    assert(stats.maxActiveCursors <= result.clients);
    if (job.policy === "shared") assert.equal(stats.maxActiveCursors, 1);
    if (job.policy === "separate" && job.latency === 100) assert.equal(stats.maxActiveCursors, job.concurrency);
    result.server = stats;
    result.round = job.round;
    writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    all.push(result);
    writeFileSync(`${output}all.json`, JSON.stringify(all, null, 2) + "\n");
    console.log(`Completed ${ji + 1}/${jobs.length}`);
  } catch (error) {
    writeFileSync(`${output}raw/${stem}.failure.json`, JSON.stringify({ job, error: String(error) }, null, 2) + "\n");
    throw error;
  } finally {
    const done = exited(server);
    server.send({ type: "stop" });
    await done;
  }
}
for (const [path, hash] of Object.entries(fingerprints)) assert.equal(digest(root + path), hash, path);
for (const f of fixtures.cases) assert.equal(digest(f.path), f.fixtureSha256);
writeFileSync(`${output}validation.json`, JSON.stringify({
  passed: true, workers: all.length, timedExports: all.reduce((n, r) => n + r.timedExports, 0),
  hashVerifiedExports: all.reduce((n, r) => n + r.verification.exports.length, 0),
  fixtureFingerprintsUnchanged: true, packageFingerprintsUnchanged: true, harnessFingerprintsUnchanged: true,
  allSessionsClosed: true, oneSessionPerClient: true, oneSelectPerExport: true, noPreflights: true,
  sharedSerializes: true, separateClientsOverlapAt100ms: true,
}, null, 2) + "\n");
console.log(`Finished ${jobs.length} workers; byte hashes, request counts, session overlap/cleanup and fingerprints passed.`);

function message(child, type, id) {
  return new Promise((resolve, reject) => {
    const clean = () => { child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit); };
    const onMessage = (m) => { if (m.type === type && (!id || m.id === id)) { clean(); resolve(m); } };
    const onError = (e) => { clean(); reject(e); };
    const onExit = (code) => onError(Error(`Server exited early: ${code}`));
    child.on("message", onMessage); child.once("error", onError); child.once("exit", onExit);
  });
}
function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(Error(`Process failed: ${code}`)));
  });
}
