import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate, setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { exportQuery, exportTable } from "../dist/index.mjs";

const [method, databasePath, destination, outputPath, firstRecordBytes] =
  process.argv.slice(2);
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
let firstRecordMs = null;
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
      if (firstRecordMs === null && bytes >= Number(firstRecordBytes))
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

// Same UTF-8 target batch size, completion semantics and yielding cadence as ExportLite.
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
    const done = finished(sink, { cleanup: true });
    sink.end();
    await done;
  }
}

let rows = 0;
started = performance.now();
previousLoopCheck = started;
if (method === "exportlite") {
  rows = (
    await exportTable(db, "data", {
      format: "json",
      output: sink,
      end: true,
    })
  ).rowsExported;
} else if (method === "exportlite-query") {
  rows = (
    await exportQuery(db, { sql, format: "json", output: sink, end: true })
  ).rowsExported;
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
  await Promise.all([pipeline(child.stdout, sink), exited]);
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
const durationMs = performance.now() - started;
sample();
clearInterval(interval);
await setTimeout(5);
clearInterval(loopInterval);
observer.disconnect();
if (file) await finished(file, { cleanup: true });
const cli = method === "sqlite-cli";
const metrics = {
  method,
  destination,
  rows,
  bytes,
  durationMs,
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
