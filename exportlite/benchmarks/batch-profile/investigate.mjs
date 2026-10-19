import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { planBatchedTable } from "../baselines/pre-batch-tuning/engine.mjs";
import { exportTable } from "../baselines/pre-batch-tuning/index.mjs";
import { boundarySql } from "./candidate.mjs";

const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const db = new Database(
  "<temporary>/exportlite-matched-api-20261017/fixture.db",
  { readonly: true },
);
const outputDirectory = new URL("../results/batch-profile/", import.meta.url);
const sql = planBatchedTable(db, {
  table: "users",
  columnNames: ["id", "name"],
  columns: ["name"],
  format: "json",
}).source;
const candidates = {
  baseline: sql,
  "binary-bounds": sql.replaceAll("json_array(min", "jsonb_array(min"),
  "fixed-boundaries": boundarySql("users", ["name"]),
  full: "SELECT json_group_array(json_object('name',name)) FROM (SELECT name FROM users ORDER BY rowid)",
};
const expected = createHash("sha256")
  .update(db.prepare(candidates.full).pluck().get())
  .digest("hex");
function run(name, verify = false) {
  const statement = db.prepare(candidates[name]);
  let rows = 0;
  let chars = 0;
  const hash = verify ? createHash("sha256") : undefined;
  if (name === "full") {
    const text = statement.pluck().get();
    rows = 1_000_000;
    chars = text.length;
    hash?.update(text);
  } else {
    hash?.update("[");
    for (const [text, count] of statement.raw().iterate()) {
      if (rows) hash?.update(",");
      hash?.update(text.slice(1, -1));
      rows += Number(count);
      chars += text.length;
    }
    hash?.update("]");
  }
  assert.equal(rows, 1_000_000);
  if (hash) assert.equal(hash.digest("hex"), expected);
  return chars;
}
for (const name of Object.keys(candidates)) {
  run(name, true);
  run(name);
}
const observations = [];
for (let round = 0; round < 5; round++) {
  const names = Object.keys(candidates);
  for (let index = 0; index < names.length; index++) {
    const name = names[(index + round) % names.length];
    const started = performance.now();
    const chars = run(name);
    observations.push({ name, round, ms: performance.now() - started, chars });
  }
}
let sqlMs = 0;
let batches = 0;
let encodingMs = 0;
const connection = {
  prepare(text) {
    const statement = db.prepare(text);
    if (text.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        const iterator = iterate(...params);
        try {
          while (true) {
            const started = performance.now();
            const next = iterator.next();
            sqlMs += performance.now() - started;
            if (next.done) return;
            batches++;
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
await exportTable(db, "users", {
  columns: ["name"],
  format: "json",
  output: new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
  end: true,
});
const started = performance.now();
await exportTable(connection, "users", {
  columns: ["name"],
  format: "json",
  output: new Writable({
    decodeStrings: false,
    write(text, _encoding, callback) {
      const encodingStarted = performance.now();
      Buffer.from(text, "utf8");
      encodingMs += performance.now() - encodingStarted;
      callback();
    },
  }),
  end: true,
});
const totalMs = performance.now() - started;
const plans = Object.fromEntries(
  Object.entries(candidates).map(([name, text]) => [
    name,
    {
      sql: text,
      plan: db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(),
      bytecode: db.prepare(`EXPLAIN ${text}`).all(),
    },
  ]),
);
const result = {
  environment: {
    node: process.version,
    sqlite: db.prepare("SELECT sqlite_version() v").get().v,
  },
  expected,
  observations,
  instrumentedPublicBaseline: {
    totalMs,
    sqliteAndDriverMs: sqlMs,
    encodingMs,
    otherMs: totalMs - sqlMs - encodingMs,
    batches,
  },
  plans,
};
writeFileSync(
  new URL("screening.json", outputDirectory),
  `${JSON.stringify(result, null, 2)}\n`,
);
for (const name of Object.keys(candidates)) {
  const values = observations
    .filter((r) => r.name === name)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  console.log(name, values[2].toFixed(2), "ms");
}
console.log(result.instrumentedPublicBaseline);
db.close();
