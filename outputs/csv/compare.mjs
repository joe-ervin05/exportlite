import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../exportlite");
const require = createRequire(join(pkg, "package.json"));
const columns = ["id", "name", "note", "active"];
const sql = `SELECT ${columns.join(",")} FROM data ORDER BY id`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
assert.equal(process.version, "v26.12.0");

if (process.argv[2] === "worker") {
  const [fixtureText, method, compression] = process.argv.slice(3);
  const fixture = JSON.parse(fixtureText);
  const zip = compression === "zip";
  const Database = require("better-sqlite3");
  const db = new Database(fixture.path, { readonly: true });
  const api = method.startsWith("exportlite")
    ? await import(pathToFileURL(join(pkg, "dist/index.mjs"))) : undefined;
  const stringify = method === "csv-stringify" ? require("csv-stringify").stringify : undefined;
  const ZipStream = zip ? (await import(pathToFileURL(require.resolve("zip-stream")))).default : undefined;
  const declared = api && { id: api.integer().primaryKey(), name: api.text(), note: api.text(), active: api.integer() };
  const quote = (value) => value === null ? "" : typeof value === "string" ? `"${value.replaceAll('"', '""')}"` : String(value);

  // Same 64 KiB flush target, byte encoding and callback/drain waits as ExportLite.
  // The baseline owns its streams and can end them directly.
  async function generate(sink) {
    const statement = db.prepare(sql);
    let parts = [], size = 0;
    async function flush() {
      if (!size) return;
      const bytes = typeof parts[0] === "string" ? Buffer.from(parts.join("")) : Buffer.concat(parts, size);
      parts = []; size = 0;
      await new Promise((resolve, reject) => {
        let callbackDone = false, drained = false, writing = true;
        const cleanup = () => { sink.off("error", fail); sink.off("drain", onDrain); };
        const complete = () => { if (!writing && callbackDone && drained) { cleanup(); resolve(); } };
        const fail = (error) => { cleanup(); reject(error); };
        const onDrain = () => { drained = true; complete(); };
        sink.once("error", fail); sink.once("drain", onDrain);
        drained = sink.write(bytes, (error) => { if (error) return; callbackDone = true; complete(); });
        writing = false; complete();
      });
    }
    function append(value) {
      parts.push(value); size += Buffer.byteLength(value);
      return size >= 65_536 ? flush() : undefined;
    }
    if (stringify) {
      async function* records() {
        let count = 0;
        for (const row of statement.iterate()) { yield row; if (++count % 2048 === 0) await tick(); }
      }
      const encoder = stringify({ columns, header: true, quoted_string: true, record_delimiter: "\r\n" });
      const producing = pipeline(Readable.from(records()), encoder);
      producing.catch(() => {});
      for await (const bytes of encoder) { const waiting = append(bytes); if (waiting) await waiting; }
      await producing;
    } else {
      append(columns.map(quote).join(",") + "\r\n");
      let count = 0;
      for (const row of statement.iterate()) {
        const record = `${quote(row.id)},${quote(row.name)},${quote(row.note)},${quote(row.active)}\r\n`;
        const waiting = append(record); if (waiting) await waiting;
        if (++count % 2048 === 0) await tick();
      }
    }
    await flush();
    const done = finished(sink, { readable: false, cleanup: true });
    sink.end(); await done;
  }
  async function consume(verify) {
    let bytes = 0;
    const hash = verify ? createHash("sha256") : undefined;
    const sink = new Writable({ highWaterMark: 65_536, write(chunk, _encoding, callback) { bytes += chunk.length; hash?.update(chunk); callback(); } });
    if (api) {
      const options = { columns: declared, format: "csv", zip, output: sink, end: true };
      const stats = method === "exportlite-table" ? await api.exportTable(db, "data", options) : await api.exportQuery(db, { ...options, sql });
      assert.equal(stats.rowsExported, fixture.rows); assert.equal(stats.bytesWritten, bytes);
    } else if (zip) {
      const input = new PassThrough({ highWaterMark: 65_536 });
      const archive = new ZipStream({ forceZip64: true, zlib: { level: 1, memLevel: 9, chunkSize: 262_144 } });
      const done = pipeline(archive, sink); done.catch(() => {});
      archive.entry(input, { name: "data.csv", date: new Date("1980-01-01T00:00:00Z") }, (error) => error ? archive.destroy(error) : archive.finalize());
      try { await generate(input); await done; }
      catch (error) { input.destroy(); archive.destroy(error); await done.catch(() => {}); throw error; }
    } else await generate(sink);
    return { bytes, ...(hash ? { sha256: hash.digest("hex") } : {}) };
  }
  // Match table ZIP entry names for both ExportLite paths.
  // Query exports use export.csv; ZIP hash differences for that path are expected.
  try {
    const verified = await consume(true);
    for (let i = 0; i < 2; i++) await consume(false);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      for (let j = 0; j < fixture.iterations; j++) await consume(false);
      samples.push((performance.now() - started) / fixture.iterations);
    }
    process.stdout.write(JSON.stringify({ fixture: fixture.name, method, compression, ...verified, samplesMs: samples, medianMs: median(samples), peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
  } finally { db.close(); }
} else {
  const { createFixture } = await import(pathToFileURL(join(pkg, "benchmarks/fixture.mjs")));
  const { stringify } = require("csv-stringify/sync");
  const { parse } = require("csv-parse/sync");
  const Database = require("better-sqlite3");
  const temporary = await mkdtemp(join(tmpdir(), "exportlite-csv-bench-"));
  const fixtures = [
    { name: "tiny", rows: 100, width: 32, profile: "repeated", iterations: 50 },
    { name: "narrow", rows: 50000, width: 32, profile: "varied", iterations: 2 },
    { name: "wide", rows: 15000, width: 1024, profile: "varied", iterations: 2 },
  ];
  const methods = ["exportlite-table", "exportlite-query", "js-stream", "csv-stringify"];
  const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
  const results = [];
  await mkdir(here, { recursive: true });
  try {
    for (const fixture of fixtures) {
      fixture.path = join(temporary, `${fixture.name}.sqlite`);
      const info = createFixture(fixture.path, fixture.rows, { ...fixture, seed: 20261017 });
      const db = new Database(fixture.path, { readonly: true });
      try {
        const rows = db.prepare(sql).all();
        const csv = stringify(rows, { columns, header: true, quoted_string: true, record_delimiter: "\r\n" });
        assert.deepEqual(parse(csv, { columns: true }), rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? "" : String(value)]))));
        fixture.expectedBytes = Buffer.byteLength(csv);
        fixture.expectedSha256 = createHash("sha256").update(csv).digest("hex");
        fixture.sqliteVersion = info.sqliteVersion;
        fixture.databaseSha256 = createHash("sha256").update(await readFile(fixture.path)).digest("hex");
      } finally { db.close(); }
    }
    for (let round = 0; round < rounds; round++) {
      for (const fixture of fixtures) for (const compression of ["none", "zip"]) {
        const order = [...methods.slice(round % 4), ...methods.slice(0, round % 4)];
        for (const method of order) {
          const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "worker", JSON.stringify(fixture), method, compression], { encoding: "utf8", maxBuffer: 1024 * 1024 });
          assert.equal(child.status, 0, child.stderr);
          const row = { round, ...JSON.parse(child.stdout) };
          if (compression === "none") { assert.equal(row.bytes, fixture.expectedBytes); assert.equal(row.sha256, fixture.expectedSha256); }
          results.push(row);
        }
      }
      await writeFile(join(here, "all.json"), `${JSON.stringify(results, null, 2)}\n`);
      process.stderr.write(`Finished CSV round ${round + 1}/${rounds}.\n`);
    }
    const summary = [];
    for (const fixture of fixtures) for (const compression of ["none", "zip"]) {
      const group = results.filter((row) => row.fixture === fixture.name && row.compression === compression);
      const sameName = group.filter((row) => row.method !== "exportlite-query");
      assert.equal(new Set(sameName.map((row) => row.sha256)).size, 1);
      for (const method of methods) {
        const rows = group.filter((row) => row.method === method);
        assert.equal(new Set(rows.map((row) => row.sha256)).size, 1);
        summary.push({ fixture: fixture.name, compression, method, medianMs: median(rows.map((row) => row.medianMs)), minWorkerMs: Math.min(...rows.map((row) => row.medianMs)), maxWorkerMs: Math.max(...rows.map((row) => row.medianMs)), medianPeakRssMiB: median(rows.map((row) => row.peakRssMiB)), maxPeakRssMiB: Math.max(...rows.map((row) => row.peakRssMiB)), bytes: rows[0].bytes, sha256: rows[0].sha256 });
      }
    }
    await writeFile(join(here, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
    const build = {};
    for (const file of (await readdir(join(pkg, "dist"))).filter((name) => name.endsWith(".mjs")).sort())
      build[file] = createHash("sha256").update(await readFile(join(pkg, "dist", file))).digest("hex");
    await writeFile(join(here, "configuration.json"), `${JSON.stringify({ node: process.version, nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), cpu: cpus()[0]?.model, rounds, methods, build, sourceCommitBeforeCsv: "a22c0105e49429b18ac4a3881f4fdfb38e253b08", fixtures: fixtures.map(({ path, ...rest }) => rest), versions: Object.fromEntries(["better-sqlite3", "csv-stringify", "csv-parse", "zip-stream"].map((name) => [name, manifest.devDependencies[name] ?? manifest.dependencies[name]])), protocol: "Sequential fresh workers, rotating method order. One hash verification, two warmups, three timed request batches per worker. Median of worker medians, natural GC. Counting Node writable; no disk or HTTP delivery. Whole-process peak RSS includes imports, connection setup, verification and warmups. Same 64 KiB flush target and 2048-row yields. ZIP level 1, memLevel 9, 256 KiB chunks. Plain CSV matches csv-stringify exactly and independently parses to fixture values. ZIP hashes match table/manual/library methods; query ZIP differs by entry name. Query planning and statement preparation included in time; connection/import setup excluded. Full SQLite aggregation is deliberately excluded because CSV production must remain streaming." }, null, 2)}\n`);
    console.log(JSON.stringify({ workers: results.length, cases: summary.length }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
