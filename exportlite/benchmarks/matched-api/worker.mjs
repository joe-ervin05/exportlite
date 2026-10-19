import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import Database from "better-sqlite3";
import { exportTable } from "../../dist/index.mjs";
import { streamExport } from "./build/engine-entry.mjs";
import { createQueries } from "./reference/queries.mjs";
import { batchedJsonSql, rootJsonSql } from "./root-sql.mjs";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const roots = Number(options.roots);
const depth = Number(options.depth);
const method = options.method;
const db = new Database(options.db, { readonly: true });
db.pragma("query_only=ON");
const queries = createQueries(db, depth);
const reference = JSON.parse(
  readFileSync(new URL("./reference/summary.json", import.meta.url)),
);
const expected = reference.cases.find(
  (row) => row.roots === roots && row.depth === depth,
);
assert(expected, "Case must exist in the original fixture matrix");

// Remove only the outer, complete-response aggregate. Each root retains the
// exact original correlated JSON expressions, ordering, fields and LIMIT.
const rootSql = rootJsonSql(queries.sql.revised);
const rootStatement = db.prepare(rootSql);
const batchSql = batchedJsonSql(
  db,
  queries.sql.revised,
  roots === 1_000_000 && depth === 0,
);
const batchStatement = db.prepare(batchSql);
assert.equal(rootStatement.columns().length, 1);

// decodeStrings:false makes UTF-8 allocation explicit and measurable. No disk,
// network, compression or hash runs inside the measured encoding interval.
class BodySink extends Writable {
  constructor(verify = false) {
    super({ decodeStrings: false, highWaterMark: 65_536 });
    this.bytes = 0;
    this.chunks = 0;
    this.encodingMs = 0;
    this.hash = verify ? createHash("sha256") : undefined;
    this.parts = verify && roots <= 100 ? [] : undefined;
  }
  _write(text, _encoding, callback) {
    const started = performance.now();
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    if (typeof text === "string")
      this.encodingMs += performance.now() - started;
    this.bytes += bytes.length;
    this.chunks++;
    this.hash?.update(bytes);
    this.parts?.push(bytes);
    callback();
  }
}

async function respond(verify = false) {
  if (method === "public-web-table") {
    const hash = verify ? createHash("sha256") : undefined;
    let bytes = 0;
    let chunks = 0;
    const started = performance.now();
    const stream = await exportTable(db, "users", {
      columns: ["name"],
      format: "json",
    });
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      chunks++;
      hash?.update(chunk);
    }
    await stream.result;
    return {
      totalMs: performance.now() - started,
      generationMs: null,
      encodingMs: null,
      bytes,
      chunks,
      sha256: hash?.digest("hex"),
    };
  }
  const sink = new BodySink(verify);
  const completed = finished(sink, { cleanup: true });
  const started = performance.now();
  if (method === "exportlite") {
    await streamExport(
      batchStatement,
      [{ roots }],
      { format: "json", output: sink, end: true },
      started,
      true,
    );
  } else if (method === "exportlite-rows") {
    await streamExport(
      rootStatement,
      [roots],
      { format: "json", output: sink, end: true },
      started,
    );
  } else if (method === "public-table-256") {
    assert.equal(roots, 1_000_000);
    assert.equal(depth, 0);
    await exportTable(db, "users", {
      columns: ["name"],
      format: "json",
      output: sink,
      end: true,
    });
  } else {
    const name = {
      sqlite: "revised_sql_direct",
      manual: "js_rows_group_stringify",
      drizzle: "drizzle_relational_stringify",
    }[method];
    assert(name, `Unknown method: ${method}`);
    sink.end(queries.methods[name](roots));
  }
  await completed;
  const totalMs = performance.now() - started;
  if (sink.parts) {
    const users = JSON.parse(Buffer.concat(sink.parts).toString("utf8"));
    assert.equal(users.length, roots);
    for (const user of users) {
      if (depth > 0) assert.equal(user.posts.length, 2);
      if (depth > 1)
        for (const post of user.posts) assert.equal(post.comments.length, 2);
    }
  }
  return {
    totalMs,
    generationMs: totalMs - sink.encodingMs,
    encodingMs: sink.encodingMs,
    bytes: sink.bytes,
    chunks: sink.chunks,
    sha256: sink.hash?.digest("hex"),
  };
}

const verification = await respond(true);
assert.equal(
  verification.sha256,
  expected.sha256,
  "Full UTF-8 output must match the original benchmark",
);
assert.equal(verification.bytes, expected.response_bytes);
const warmupCount = roots <= 1000 ? 100 : roots <= 10_000 ? 10 : 1;
const warmup = [];
for (let i = 0; i < warmupCount; i++) warmup.push((await respond()).totalMs);
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
const iterations = Math.max(
  1,
  Math.min(20_000, Math.floor(40 / median(warmup.slice(-5)))),
);
const rounds = roots < 100_000 ? 5 : 3;
const samples = [];
for (let round = 0; round < rounds; round++) {
  let totalMs = 0;
  let encodingMs = 0;
  let chunks = 0;
  const cpuStarted = process.cpuUsage();
  for (let i = 0; i < iterations; i++) {
    const result = await respond();
    assert.equal(result.bytes, expected.response_bytes);
    totalMs += result.totalMs;
    encodingMs += result.encodingMs ?? 0;
    chunks += result.chunks;
  }
  const cpu = process.cpuUsage(cpuStarted);
  samples.push({
    totalMs: totalMs / iterations,
    generationMs:
      method === "public-web-table"
        ? null
        : (totalMs - encodingMs) / iterations,
    encodingMs: method === "public-web-table" ? null : encodingMs / iterations,
    chunks: chunks / iterations,
    cpuMs: (cpu.user + cpu.system) / 1000 / iterations,
  });
}
const result = {
  fingerprint: options.fingerprint,
  roots,
  depth,
  method,
  bytes: expected.response_bytes,
  sha256: verification.sha256,
  totalRecords: expected.total_records,
  warmupCount,
  iterations,
  rounds,
  samples,
  totalMs: median(samples.map((s) => s.totalMs)),
  generationMs: [...samples].sort((a, b) => a.totalMs - b.totalMs)[
    Math.floor(rounds / 2)
  ].generationMs,
  encodingMs: [...samples].sort((a, b) => a.totalMs - b.totalMs)[
    Math.floor(rounds / 2)
  ].encodingMs,
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
  environment: {
    node: process.version,
    v8: process.versions.v8,
    sqlite: db.prepare("SELECT sqlite_version() v").get().v,
    betterSqlite3: "13.0.3",
    drizzle: "0.45.4",
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    flags: process.execArgv,
  },
  rootSql,
  batchSql,
};
db.close();
writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
