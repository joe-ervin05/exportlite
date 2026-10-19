import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const pkg = join(root, "exportlite");
const require = createRequire(join(pkg, "package.json"));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const before = process.env.EXPORTLITE_BEFORE ?? join(here, "baseline/dist");
const after = process.env.EXPORTLITE_AFTER ?? join(pkg, "dist");

if (process.argv[2] === "worker") {
  const [, , , variant, fixtureText, method, zipped] = process.argv;
  const fixture = JSON.parse(fixtureText);
  const zip = zipped === "true";
  const adapter = method.startsWith("drizzle");
  const api = await import(pathToFileURL(join(
    variant === "before" ? before : after, adapter ? "drizzle.mjs" : "index.mjs",
  )));
  const Database = require("better-sqlite3");
  const client = new Database(fixture.path, { readonly: true });
  let db;
  let table;
  let columns;
  if (adapter) {
    const { drizzle } = require("drizzle-orm/better-sqlite3");
    const { integer, text, sqliteTable } = require("drizzle-orm/sqlite-core");
    table = sqliteTable("data", {
      id: integer().primaryKey(), name: text(), note: text(), active: integer(),
    });
    db = drizzle(client);
  } else {
    columns = { id: api.integer().primaryKey(), name: api.text(), note: api.text(), active: api.integer() };
  }
  async function consume(verify) {
    let bytes = 0;
    const hash = verify ? createHash("sha256") : undefined;
    const output = fixture.web ? undefined : new Writable({
      write(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash?.update(chunk);
        callback();
      },
    });
    const options = { format: "json", zip, ...(output ? { output, end: true } : {}) };
    let result;
    if (method === "table") result = await api.exportTable(client, "data", { ...options, columns });
    else if (method === "query") result = await api.exportQuery(client, {
      ...options, columns, sql: "SELECT id,name,note,active FROM data ORDER BY id",
    });
    else if (method === "drizzle-table") result = await api.exportTable(db, table, options);
    else result = await api.exportQuery(db, db.select().from(table).orderBy(table.id), options);
    let stats = result;
    if (fixture.web) {
      const body = new Uint8Array(await new Response(result).arrayBuffer());
      bytes = body.length;
      hash?.update(body);
      stats = await result.result;
    }
    assert.equal(stats.rowsExported, fixture.rows);
    assert.equal(stats.bytesWritten, bytes);
    if (!zip) assert.equal(bytes, fixture.expectedJsonBytes);
    return { bytes, ...(hash ? { sha256: hash.digest("hex") } : {}) };
  }
  try {
    const verified = await consume(true);
    for (let i = 0; i < 2; i++) await consume(false);
    const samples = [];
    for (let batch = 0; batch < 3; batch++) {
      const started = performance.now();
      for (let i = 0; i < fixture.iterations; i++) await consume(false);
      samples.push((performance.now() - started) / fixture.iterations);
    }
    process.stdout.write(JSON.stringify({
      variant, fixture: fixture.name, method, zip, ...verified,
      samplesMs: samples, medianMs: median(samples),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }));
  } finally { client.close(); }
} else {
  const { createFixture } = await import(pathToFileURL(join(pkg, "benchmarks/fixture.mjs")));
  const temporary = await mkdtemp(join(tmpdir(), "exportlite-phase2-"));
  const fixtures = [
    { name: "tiny", rows: 100, width: 32, profile: "repeated", iterations: 100, web: true },
    { name: "narrow", rows: 50000, width: 32, profile: "varied", iterations: 2, web: false },
    { name: "wide", rows: 15000, width: 1024, profile: "varied", iterations: 2, web: false },
  ];
  const methods = (process.env.BENCH_METHODS ?? "table,query,drizzle-table,drizzle-query").split(",");
  const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
  const selectedFixtures = (process.env.BENCH_FIXTURES ?? "tiny,narrow,wide").split(",");
  const compressions = (process.env.BENCH_COMPRESSIONS ?? "none,zip").split(",");
  const results = [];
  const destination = process.env.BENCH_OUT ?? here;
  await mkdir(destination, { recursive: true });
  try {
    for (const fixture of fixtures) {
      fixture.path = join(temporary, `${fixture.name}.sqlite`);
      const info = createFixture(fixture.path, fixture.rows, {
        width: fixture.width, profile: fixture.profile, seed: 20261017,
      });
      fixture.expectedJsonBytes = info.expectedJsonBytes;
      fixture.databaseSha256 = createHash("sha256").update(await readFile(fixture.path)).digest("hex");
    }
    for (let round = 0; round < rounds; round++) {
      for (const fixture of fixtures.filter((f) => selectedFixtures.includes(f.name))) {
        for (const method of methods) {
          for (const compression of compressions) {
            for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
              const child = spawnSync(process.execPath, [
                fileURLToPath(import.meta.url), "worker", variant,
                JSON.stringify(fixture), method, String(compression === "zip"),
              ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
              assert.equal(child.status, 0, child.stderr);
              results.push({ round, ...JSON.parse(child.stdout) });
            }
          }
        }
      }
      await writeFile(join(destination, "all.json"), `${JSON.stringify(results, null, 2)}\n`);
      process.stderr.write(`Finished paired round ${round + 1}/${rounds}.\n`);
    }
    const summary = [];
    for (const fixture of selectedFixtures) for (const method of methods) for (const compression of compressions) {
      const group = results.filter((r) => r.fixture === fixture && r.method === method && r.zip === (compression === "zip"));
      const old = group.filter((r) => r.variant === "before");
      const current = group.filter((r) => r.variant === "after");
      assert.equal(new Set(group.map((r) => r.sha256)).size, 1);
      assert.equal(new Set(group.map((r) => r.bytes)).size, 1);
      const beforeMs = median(old.map((r) => r.medianMs));
      const afterMs = median(current.map((r) => r.medianMs));
      const beforeRssMiB = median(old.map((r) => r.peakRssMiB));
      const afterRssMiB = median(current.map((r) => r.peakRssMiB));
      summary.push({ fixture, method, compression, beforeMs, afterMs,
        timeChangePercent: 100 * (afterMs / beforeMs - 1), beforeRssMiB, afterRssMiB,
        rssChangePercent: 100 * (afterRssMiB / beforeRssMiB - 1),
        maxBeforeRssMiB: Math.max(...old.map((r) => r.peakRssMiB)),
        maxAfterRssMiB: Math.max(...current.map((r) => r.peakRssMiB)),
        bytes: group[0].bytes, sha256: group[0].sha256,
      });
    }
    const builds = {};
    for (const [name, path] of [["before", before], ["after", after]]) {
      builds[name] = {};
      for (const file of (await readdir(path)).filter((f) => f.endsWith(".mjs")).sort())
        builds[name][file] = createHash("sha256").update(await readFile(join(path, file))).digest("hex");
    }
    await writeFile(join(destination, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(destination, "configuration.json"), `${JSON.stringify({
      node: process.version, nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
      cpu: cpus()[0]?.model, rounds, methods, compressions, builds,
      fixtures: fixtures.filter((f) => selectedFixtures.includes(f.name)).map(({ path, ...rest }) => rest),
      protocol: "Sequential fresh workers; paired order alternates by round. One hash verification, two warmups, then three timed request batches per worker. Median of worker medians. Natural GC. Tiny cases consume Web streams; bulk cases drain to counting Node writables. Includes statement/query construction, execution, JSON generation, ZIP when requested, UTF-8 delivery and completion. Imports and connection/schema setup excluded from timing but included in process peak RSS. Same fixture files per pair; output bytes and SHA-256 must match. No disk output or network timing.",
    }, null, 2)}\n`);
    console.log(JSON.stringify({ workers: results.length, cases: summary.length,
      timeChangePercent: summary.map((r) => Number(r.timeChangePercent.toFixed(1))),
      maxRssChangePercent: Math.max(...summary.map((r) => r.rssChangePercent)),
    }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
