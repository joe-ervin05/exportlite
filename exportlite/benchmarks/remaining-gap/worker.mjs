import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
assert.equal(process.version, "v26.12.0");
const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const before = await import("../baselines/pre-stream-tuning/index.mjs");
const after = await import("../../dist/index.mjs");
const oldEngine = await import("../baselines/pre-stream-tuning/engine.mjs");
const newEngine = await import("../matched-api/build/engine-entry.mjs");
const fixture = options.dataset ?? "matched";
const method = options.method ?? "before";
const mode = options.mode ?? "output";
const count = fixture === "wide" ? 100_000 : 1_000_000;
const table = fixture === "matched" ? "users" : "data";
const columns =
  fixture === "matched" ? ["name"] : ["id", "name", "note", "active"];
const database =
  fixture === "matched"
    ? "<temporary>/exportlite-matched-api-20261017/fixture.db"
    : `<temporary>/exportlite-batch-profile-20261017/${fixture}.db`;
const db = new Database(options.db ?? database, { readonly: true });
const api = method === "before" ? before : after;
const engine = method === "before" ? oldEngine : newEngine;
const pairs = columns.map((name) => `'${name}', "${name}"`).join(",");
const fullSql = `SELECT json_group_array(json_object(${pairs})) FROM (SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM main."${table}" ORDER BY rowid)`;
const actualFullSql =
  method === "full-blob"
    ? fullSql.replace(
        `json_group_array(json_object(${pairs}))`,
        `CAST(json_group_array(json_object(${pairs})) AS BLOB)`,
      )
    : fullSql;
const fullStatement = db.prepare(actualFullSql).pluck();
// Reference materialization happens in a separate fixture-preparation process,
// so streaming workers never allocate the full response just to verify it.
const expected = JSON.parse(
  readFileSync(
    options.fixtures ?? "benchmarks/results/batch-profile/fixtures.json",
    "utf8",
  ),
)[fixture].expected;
let sqliteMs = 0;
let batchCount = 0;
const instrument = options.instrument === "1";
const connection = {
  prepare(sql) {
    const statement = db.prepare(sql);
    if (instrument && sql.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        const iterator = iterate(...params);
        try {
          while (true) {
            const started = performance.now();
            const next = iterator.next();
            sqliteMs += performance.now() - started;
            if (next.done) return;
            batchCount++;
            yield next.value;
          }
        } finally {
          iterator.return?.();
        }
      };
    }
    return statement;
  },
};
const planned = engine.planBatchedTable(db, {
  table,
  columnNames: ["id", "name", "note", "active"],
  columns,
  format: "json",
});
assert(planned);

async function run(verify = false) {
  let bytes = 0;
  let encodingMs = 0;
  let rows = count;
  const hash = verify ? createHash("sha256") : undefined;
  const sink = new Writable({
    decodeStrings: false,
    write(text, _encoding, callback) {
      const started = performance.now();
      const buffer =
        typeof text === "string" ? Buffer.from(text, "utf8") : text;
      if (typeof text === "string") encodingMs += performance.now() - started;
      bytes += buffer.length;
      hash?.update(buffer);
      callback();
    },
  });
  const startedSql = sqliteMs;
  const startedBatches = batchCount;
  const started = performance.now();
  if (mode === "sql") {
    hash?.update("[");
    rows = 0;
    for (const [text, size] of planned.raw().iterate()) {
      const content = text.slice(1, -1);
      if (rows) hash?.update(",");
      hash?.update(content);
      bytes += Buffer.byteLength(content) + (rows ? 1 : 0);
      rows += Number(size);
    }
    hash?.update("]");
    bytes += 2;
  } else if (method.startsWith("full")) {
    const complete = finished(sink, { cleanup: true });
    sink.end(fullStatement.get());
    await complete;
  } else if (mode === "web" || mode === "zip") {
    const stream = await api.exportTable(connection, table, {
      columns,
      format: "json",
      zip: mode === "zip",
    });
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      hash?.update(chunk);
    }
    rows = (await stream.result).rowsExported;
  } else if (mode === "rows") {
    const result = await api.exportQuery(connection, {
      sql: `SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM main."${table}" ORDER BY rowid`,
      format: "json",
      output: sink,
      end: true,
    });
    rows = result.rowsExported;
    assert.equal(result.bytesWritten, bytes);
  } else {
    const result = await api.exportTable(connection, table, {
      columns,
      format: "json",
      output: sink,
      end: true,
    });
    rows = result.rowsExported;
    assert.equal(result.bytesWritten, bytes);
  }
  const totalMs = performance.now() - started;
  assert.equal(rows, count);
  if (mode !== "zip") {
    assert.equal(bytes, expected.bytes);
    if (verify) assert.equal(hash.digest("hex"), expected.sha256);
  }
  return {
    totalMs,
    encodingMs: ["output", "rows"].includes(mode) ? encodingMs : null,
    sqliteAndDriverMs: instrument ? sqliteMs - startedSql : null,
    batches: instrument ? batchCount - startedBatches : null,
    bytes,
    sha256: verify && mode === "zip" ? hash.digest("hex") : expected.sha256,
  };
}
const verification = await run(true);
await run();
const samples = [];
let session;
let post;
if (options.profile) {
  session = new Session();
  session.connect();
  post = promisify(session.post.bind(session));
  await post("Profiler.enable");
  await post("Profiler.start");
}
for (let repeat = 0; repeat < Number(options.samples ?? 3); repeat++)
  samples.push(await run());
if (post) {
  const { profile } = await post("Profiler.stop");
  writeFileSync(options.profile, JSON.stringify(profile));
  session.disconnect();
}
const ordered = [...samples].sort((a, b) => a.totalMs - b.totalMs);
const middle = ordered[Math.floor(ordered.length / 2)];
const result = {
  dataset: fixture,
  method,
  mode,
  expected,
  verification,
  samples,
  median: middle,
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
  environment: {
    node: process.version,
    v8: process.versions.v8,
    sqlite: db.prepare("SELECT sqlite_version() v").get().v,
  },
  sql: method.startsWith("full") ? actualFullSql : planned.source,
};
db.close();
writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`${fixture} ${method} ${mode}: ${middle.totalMs.toFixed(2)} ms`);
