import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createGzip } from "node:zlib";
import Database from "better-sqlite3";
import ZipStream from "zip-stream";

const [
  method,
  databasePath,
  destination,
  outputPath,
  firstRecordBytes,
  compression = "none",
  expectedJsonBytes,
] = process.argv.slice(2);
const exporter = method.replace(
  /-(gzip-512k|gzip-slab64k|gzip-slab256k|before)$/,
  "",
);
const { exportQuery, exportTable } = await import(
  method === "exportlite-before"
    ? new URL("./baselines/pre-gzip-fix/index.mjs", import.meta.url).href
    : (process.env.EXPORTLITE_BENCH_MODULE ?? "../dist/index.mjs")
);
if (!["none", "gzip-1", "gzip-default", "zip"].includes(compression))
  throw new Error(`Unknown compression: ${compression}`);
const nativeZip =
  compression === "zip" &&
  ["exportlite", "exportlite-query"].includes(exporter);
const gzip = compression.startsWith("gzip-");
const db = new Database(databasePath, { readonly: true });
const sql = "SELECT id, name, note, active FROM data ORDER BY id";
const memory = { peakHeapBytes: 0, peakRssBytes: 0 };
function sample() {
  const usage = process.memoryUsage();
  memory.peakHeapBytes = Math.max(memory.peakHeapBytes, usage.heapUsed);
  memory.peakRssBytes = Math.max(memory.peakRssBytes, usage.rss);
}
global.gc?.();
sample();
const baselineRssBytes = process.memoryUsage().rss;
const gc = { count: 0, durationMs: 0 };
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.count++;
    gc.durationMs += entry.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
await setTimeout(10);
let previousLoopCheck = performance.now();
let maxEventLoopDelayMs = 0;
const loopInterval = setInterval(() => {
  const now = performance.now();
  maxEventLoopDelayMs = Math.max(
    maxEventLoopDelayMs,
    now - previousLoopCheck - 1,
  );
  previousLoopCheck = now;
}, 1);
let started = 0;
let bytes = 0;
let rawBytes = 0;
let rawChunks = 0;
let maxRawChunkBytes = 0;
let encodedChunks = 0;
let firstRecordMs = null;
const startedCpu = process.cpuUsage();
started = performance.now();
previousLoopCheck = started;
const file =
  destination === "file"
    ? createWriteStream(outputPath, { flags: "wx" })
    : null;
file?.on("error", (error) => sink.destroy(error));
const sink = new Writable({
  highWaterMark: 65_536,
  write(chunk, _encoding, callback) {
    const done = (error) => {
      bytes += chunk.length;
      encodedChunks++;
      if (
        compression === "none" &&
        firstRecordMs === null &&
        bytes >= Number(firstRecordBytes)
      )
        firstRecordMs = performance.now() - started;
      sample();
      callback(error);
    };
    if (file) file.write(chunk, done);
    else done();
  },
  final(callback) {
    if (file) file.end(callback);
    else callback();
  },
});
const interval = setInterval(sample, 5);
// ZIP exercises the public package API; JS uses an equivalent archive pipeline.
// Gzip remains downstream. Streaming serializers use 64 KiB flush targets;
// naive-all submits the entire JSON string in one write.
const output = nativeZip
  ? sink
  : new Transform({
      highWaterMark: 65_536,
      transform(chunk, _encoding, callback) {
        rawBytes += chunk.length;
        rawChunks++;
        maxRawChunkBytes = Math.max(maxRawChunkBytes, chunk.length);
        callback(null, chunk);
      },
    });
const stages = [output];
const gzipOptions = compression === "gzip-1" ? { level: 1 } : {};
if (method.endsWith("-gzip-512k")) gzipOptions.highWaterMark = 524_288;
if (method.endsWith("-gzip-slab64k")) gzipOptions.chunkSize = 65_536;
if (method.endsWith("-gzip-slab256k")) gzipOptions.chunkSize = 262_144;
if (process.env.EXPORTLITE_BENCH_GZIP_HIGH_WATER_MARK)
  gzipOptions.highWaterMark = Number(
    process.env.EXPORTLITE_BENCH_GZIP_HIGH_WATER_MARK,
  );
let completion;
if (nativeZip) {
  rawBytes = Number(expectedJsonBytes);
  if (!Number.isSafeInteger(rawBytes))
    throw new Error("Expected byte count required for ZIP");
  completion = finished(sink, { cleanup: true });
} else if (compression === "zip") {
  const archive = new ZipStream({
    forceZip64: true,
    zlib: { level: 1, chunkSize: 262_144, memLevel: 9 },
  });
  completion = pipeline(archive, sink);
  archive.entry(
    output,
    { name: "data.json", date: new Date("1980-01-01T00:00:00.000Z") },
    (error) => {
      if (error) archive.destroy(error);
      else archive.finalize();
    },
  );
} else {
  if (gzip) stages.push(createGzip(gzipOptions));
  stages.push(sink);
  completion = pipeline(stages);
}
// Observe failures immediately; the same promise is awaited before timing ends.
completion.catch(() => {});

// Streamed baselines match ExportLite's UTF-8 flush target and yielding cadence.
// Whole-value methods use the same writer but submit one complete JSON string.
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
        output.off("error", fail);
        output.off("drain", onDrain);
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
      output.once("error", fail);
      output.once("drain", onDrain);
      const accepted = output.write(text, (error) => {
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
    const done = finished(output, { readable: false, cleanup: true });
    output.end();
    await done;
  }
}

let rows = 0;
let exportResult;
if (exporter === "exportlite") {
  exportResult = await exportTable(db, "data", {
    format: "json",
    output,
    end: true,
    zip: nativeZip,
  });
  rows = exportResult.rowsExported;
} else if (exporter === "exportlite-query") {
  exportResult = await exportQuery(db, {
    sql,
    format: "json",
    output,
    end: true,
    zip: nativeZip,
  });
  rows = exportResult.rowsExported;
} else if (method === "sqlite-cli") {
  const child = spawn(process.env.SQLITE_BIN ?? "sqlite3", [
    "-readonly",
    "-json",
    databasePath,
    sql,
  ]);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`SQLite CLI exited ${code}: ${stderr}`)),
    );
  });
  await Promise.all([pipeline(child.stdout, output), exited]);
  rows = Number(db.prepare("SELECT count(*) FROM data").pluck().get());
} else {
  const writer = new BufferedBaseline();
  if (method === "sqlite-aggregate") {
    // The entire JSON array is built in SQLite, then crosses into JS once.
    const [text, count] = db
      .prepare(`
      SELECT json_group_array(json_object(
        'id', id, 'name', name, 'note', note, 'active', active
      )), count(*)
      FROM data
    `)
      .raw()
      .get();
    sample();
    rows = Number(count);
    const wait = writer.append(text);
    if (wait) await wait;
  } else if (method === "naive-all") {
    const objects = db.prepare(sql).all();
    sample();
    const text = JSON.stringify(objects);
    sample();
    rows = objects.length;
    const wait = writer.append(text);
    if (wait) await wait;
  } else {
    const statement = db.prepare(sql);
    const raw = method === "raw-stream";
    if (raw) statement.raw();
    const headers = statement
      .columns()
      .map((column) => `${JSON.stringify(column.name)}:`);
    writer.append("[");
    for (const row of statement.iterate()) {
      const text = raw
        ? `{${row.map((value, i) => headers[i] + JSON.stringify(value)).join(",")}}`
        : JSON.stringify(row);
      const wait = writer.append(`${rows === 0 ? "" : ","}${text}`);
      if (wait) await wait;
      rows++;
      if (rows % 2048 === 0) await setImmediate();
    }
    const wait = writer.append("]");
    if (wait) await wait;
  }
  await writer.end();
}
await completion;
if (file) await finished(file, { cleanup: true });
const durationMs = performance.now() - started;
if (nativeZip && exportResult.bytesWritten !== bytes)
  throw new Error("ZIP byte statistics mismatch");
const cpuUsage = process.cpuUsage(startedCpu);
sample();
clearInterval(interval);
await setTimeout(5);
clearInterval(loopInterval);
observer.disconnect();
const cli = method === "sqlite-cli";
const metrics = {
  method,
  destination,
  compression,
  rows,
  bytes,
  rawBytes,
  rawChunks: nativeZip ? null : rawChunks,
  meanRawChunkBytes: nativeZip ? null : rawBytes / rawChunks,
  maxRawChunkBytes: nativeZip ? null : maxRawChunkBytes,
  encodedChunks,
  gzipChunkSize: !gzip ? null : (gzipOptions.chunkSize ?? 16_384),
  gzipHighWaterMark: !gzip ? null : stages[1].writableHighWaterMark,
  zipLevel: compression === "zip" ? 1 : null,
  zipChunkSize: compression === "zip" ? 262_144 : null,
  outputRatio: bytes / rawBytes,
  durationMs,
  cpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
  rowsPerSecond: rows / (durationMs / 1000),
  mibPerSecond: bytes / 1_048_576 / (durationMs / 1000),
  firstRecordMs,
  baselineRssMiB: cli ? null : baselineRssBytes / 1_048_576,
  // Node's maxRSS is in KiB; it includes process startup and driver loading.
  peakRssMiB: cli
    ? null
    : Math.max(memory.peakRssBytes, process.resourceUsage().maxRSS * 1024) /
      1_048_576,
  sampledPeakHeapMiB: cli ? null : memory.peakHeapBytes / 1_048_576,
  gcCount: cli ? null : gc.count,
  gcDurationMs: cli ? null : gc.durationMs,
  maxEventLoopDelayMs: cli ? null : maxEventLoopDelayMs,
};
db.close();
process.stdout.write(`${JSON.stringify(metrics)}\n`);
