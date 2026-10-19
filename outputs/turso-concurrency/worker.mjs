import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [name, method, policy, concurrencyArg, url, latency, output, smoke] = process.argv.slice(2);
const concurrency = Number(concurrencyArg);
assert.equal(process.version, "v26.12.0");
const fixture = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url))).cases.find((r) => r.name === name);
assert(fixture);
const factory = await import(`${root}exportlite/dist/turso.mjs`);
const core = await import(`${root}exportlite/dist/index.mjs`);
let api = factory;
let table = fixture.table;
let columns = { id: core.integer().primaryKey(), name: core.text(), note: core.text(), active: core.integer() };
let drizzle;
if (method === "drizzle") {
  ({ drizzle } = await import(`${root}exportlite/node_modules/drizzle-orm/libsql/http/index.js`));
  const schema = await import(`${root}exportlite/node_modules/drizzle-orm/sqlite-core/index.js`);
  table = schema.sqliteTable(fixture.table, {
    id: schema.integer().primaryKey(), name: schema.text(), note: schema.text(), active: schema.integer(),
  });
  columns = { id: table.id, name: table.name, note: table.note, active: table.active };
  api = await import(`${root}exportlite/dist/drizzle.mjs`);
}
const clients = Array.from({ length: policy === "shared" ? 1 : concurrency }, () => factory.createClient({ url }));
const targets = clients.map((client) => drizzle ? drizzle(client) : client);
const initialMemory = process.memoryUsage();

async function once(lane, verify, waveStarted) {
  // All lanes are scheduled before any consumption is started. The clock starts
  // at submission, before ExportLite can acquire its per-client session lock.
  const startedMs = performance.now();
  let bytes = 0;
  const hash = verify ? createHash("sha256") : undefined;
  const sink = fixture.rows > 1000 ? new Writable({
    write(chunk, encoding, callback) { bytes += chunk.length; hash?.update(chunk); callback(); },
  }) : undefined;
  const result = await api.exportTable(targets[policy === "shared" ? 0 : lane], table, {
    columns, format: "json", ...(sink ? { output: sink, end: true } : {}),
  });
  if (sink) {
    assert.equal(result.rowsExported, fixture.rows);
    assert.equal(result.bytesWritten, bytes);
  } else {
    const buffer = await new Response(result).arrayBuffer();
    bytes = buffer.byteLength;
    hash?.update(new Uint8Array(buffer));
    assert.equal((await result.result).rowsExported, fixture.rows);
  }
  const endedMs = performance.now();
  assert.equal(bytes, fixture.expected.bytes);
  const sha256 = hash?.digest("hex");
  if (verify) assert.equal(sha256, fixture.expected.sha256);
  return { lane, bytes, sha256, totalMs: endedMs - startedMs, submittedMs: startedMs - waveStarted, completedMs: endedMs - waveStarted };
}
async function wave(verify) {
  const started = performance.now();
  const exports = await Promise.all(Array.from({ length: concurrency }, (_, lane) => Promise.resolve().then(() => once(lane, verify, started))));
  const totalMs = performance.now() - started;
  return { totalMs, exportsPerSecond: concurrency * 1000 / totalMs, exports };
}
try {
  // Untimed full-concurrency output verification doubles as a warmup for each
  // lane/client/session. Hashing contributes to process peak RSS, never timing.
  const verification = await wave(true);
  const waves = [];
  for (let i = 0; i < (smoke ? 1 : 2); i++) waves.push(await wave(false));
  const shutdownStarted = performance.now();
  await Promise.all(clients.map((client) => client.close()));
  const shutdownMs = performance.now() - shutdownStarted;
  const result = {
    name, method, policy, concurrency, latencyMs: Number(latency), clients: clients.length,
    verification, waves, shutdownMs, initialMemory, finalMemory: process.memoryUsage(),
    peakRssMiB: process.resourceUsage().maxRSS / 1024, node: process.version,
    requests: (waves.length + 1) * concurrency,
    timedExports: waves.length * concurrency,
    exportsPerSecond: waves.length * concurrency * 1000 / waves.reduce((n, w) => n + w.totalMs, 0),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`${name} ${method} ${policy} c${concurrency} +${latency}ms: ${result.exportsPerSecond.toFixed(2)} exports/s; ${result.peakRssMiB.toFixed(1)} MiB`);
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
