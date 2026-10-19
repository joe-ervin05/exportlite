import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = `${root}exportlite/`;
const require = createRequire(`${packageRoot}package.json`);
const nativeRequire = createRequire(`${packageRoot}benchmarks/matched-api/package.json`);
const Database = nativeRequire("better-sqlite3");
const { default: ZipStream } = await import(pathToFileURL(require.resolve("zip-stream")));
const { exportTable } = await import(`${packageRoot}dist/index.mjs`);
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
assert.equal(process.version, "v26.12.0");
const fixture = options.dataset;
const method = options.method;
assert(["matched", "narrow", "wide"].includes(fixture));
assert(["full-blob", "full-sliced", "exportlite", "objects"].includes(method));
const fixtureInfo = JSON.parse(readFileSync(`${packageRoot}benchmarks/results/batch-profile/fixtures.json`, "utf8"))[fixture];
const expected = fixtureInfo.expected;
const count = fixtureInfo.rows;
const table = fixture === "matched" ? "users" : "data";
const columns = fixture === "matched" ? ["name"] : ["id", "name", "note", "active"];
const entryName = `${table}.json`;
const db = new Database(fixtureInfo.path, { readonly: true });
const selectSql = `SELECT ${columns.map(name => `"${name}"`).join(",")} FROM main."${table}" ORDER BY rowid`;
const pairs = columns.map(name => `'${name}', "${name}"`).join(",");
const fullSql = `SELECT CAST(json_group_array(json_object(${pairs})) AS BLOB) FROM (${selectSql})`;
const fullStatement = db.prepare(fullSql).pluck();
const objectStatement = db.prepare(selectSql);

async function objectStream(sink) {
class BufferedBaseline {
  parts = [];
  size = 0;
  append(text) {
    this.parts.push(text);
    this.size += Buffer.byteLength(text);
    if (this.size >= 65_536) return this.flush();
    return undefined;
  }
  async flush() {
    if (this.size === 0) return;
    const text = this.parts.join("");
    this.parts = [];
    this.size = 0;
    await new Promise((resolve, reject) => {
      let written = false;
      let drained = false;
      let writing = true;
      const clean = () => {
        sink.off("error", fail);
        sink.off("drain", onDrain);
      };
      const fail = (error) => {
        clean();
        reject(error);
      };
      const complete = () => {
        if (!writing && written && drained) {
          clean();
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        complete();
      };
      sink.once("error", fail);
      sink.once("drain", onDrain);
      const accepted = sink.write(text, (error) => {
        if (error) return;
        written = true;
        complete();
      });
      drained ||= accepted;
      writing = false;
      complete();
    });
  }
  async end() {
    await this.flush();
    const done = finished(sink, { readable: false, cleanup: true });
    sink.end();
    await done;
  }
}

  const writer = new BufferedBaseline();
  let rows = 0;
  writer.append("[");
  for (const row of objectStatement.iterate()) {
    const wait = writer.append(`${rows === 0 ? "" : ","}${JSON.stringify(row)}`);
    if (wait) await wait;
    rows++;
    if (rows % 2048 === 0) await setImmediate();
  }
  const wait = writer.append("]");
  if (wait) await wait;
  await writer.end();
  return rows;
}


async function run(verify = false) {
  let bytes = 0;
  let rows = count;
  const hash = verify ? createHash("sha256") : undefined;
  const file = verify ? createWriteStream(options.archive, { flags: "wx" }) : undefined;
  const sink = new Writable({
    highWaterMark: 65_536,
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash?.update(chunk);
      if (file) file.write(chunk, callback);
      else callback();
    },
    final(callback) {
      if (file) file.end(callback);
      else callback();
    },
  });
  file?.on("error", error => sink.destroy(error));
  const started = performance.now();
  if (method === "exportlite") {
    const result = await exportTable(db, table, {
      columns, format: "json", zip: true, output: sink, end: true,
    });
    rows = result.rowsExported;
    assert.equal(result.bytesWritten, bytes);
  } else {
    const input = new PassThrough({ highWaterMark: 65_536 });
    const archive = new ZipStream({
      forceZip64: true,
      zlib: { level: 1, chunkSize: 262_144 },
    });
    const complete = pipeline(archive, sink);
    complete.catch(() => {});
    input.on("error", error => archive.destroy(error));
    archive.entry(input, {
      name: entryName, date: new Date("1980-01-01T00:00:00.000Z"),
    }, error => {
      if (error) archive.destroy(error);
      else archive.finalize();
    });
    try {
      if (method === "objects") rows = await objectStream(input);
      else {
        const buffer = fullStatement.get();
        if (method === "full-sliced") {
          for (let offset = 0; offset < buffer.length; offset += 65_536) {
            if (!input.write(buffer.subarray(offset, offset + 65_536))) await once(input, "drain");
          }
          input.end();
        } else input.end(buffer);
      }
      await complete;
    } catch (error) {
      input.destroy();
      archive.destroy(error);
      await complete.catch(() => {});
      throw error;
    }
  }
  const totalMs = performance.now() - started;
  if (file) await finished(file, { cleanup: true });
  assert.equal(rows, count);
  return { totalMs, bytes, archiveSha256: hash?.digest("hex") ?? null };
}

const verification = await run(true);
await run();
const samples = [];
for (let repeat = 0; repeat < Number(options.samples ?? 3); repeat++) {
  const sample = await run();
  assert.equal(sample.bytes, verification.bytes);
  samples.push(sample);
}
const ordered = [...samples].sort((a, b) => a.totalMs - b.totalMs);
const result = {
  dataset: fixture, method, mode: "zip-output", expected, entryName,
  verification, samples, median: ordered[Math.floor(ordered.length / 2)],
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
  environment: {
    node: process.version, v8: process.versions.v8,
    sqlite: db.prepare("SELECT sqlite_version() v").get().v,
    driver: nativeRequire("better-sqlite3/package.json").version,
    zipStream: JSON.parse(readFileSync(`${packageRoot}node_modules/zip-stream/package.json`, "utf8")).version,
    zlib: process.versions.zlib,
  },
  zip: { level: 1, chunkSize: 262_144, forceZip64: true, entryName, continuous: true },
  sql: method.startsWith("full") ? fullSql : method === "objects" ? selectSql : "Public exportTable(), fixed 256-row batches",
};
db.close();
writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`${fixture} ${method}: ${result.median.totalMs.toFixed(2)} ms; ${(result.median.bytes / 1_048_576).toFixed(2)} MiB ZIP; ${result.peakRssMiB.toFixed(1)} MiB RSS`);
