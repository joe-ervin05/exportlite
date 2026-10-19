import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { planBatchedTable } from "../baselines/pre-stream-tuning/engine.mjs";

const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
assert.equal(process.version, "v26.12.0");
const fixtures = JSON.parse(
  readFileSync("benchmarks/results/batch-profile/fixtures.json", "utf8"),
);
const observations = [];
const plans = {};
for (const dataset of ["matched", "narrow", "wide"]) {
  const db = new Database(fixtures[dataset].path, { readonly: true });
  const table = dataset === "matched" ? "users" : "data";
  const columns =
    dataset === "matched" ? ["name"] : ["id", "name", "note", "active"];
  const object = `json_object(${columns.map((name) => `'${name}', "${name}"`).join(", ")})`;
  const aggregate = `json_group_array(${object})`;
  const source = planBatchedTable(db, {
    table,
    columnNames: columns,
    columns,
    format: "json",
  }).source;
  const full = `SELECT ${aggregate} FROM (SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM main."${table}" ORDER BY rowid)`;
  const variants = {
    current: source,
    blob: source.replace(aggregate, `CAST(${aggregate} AS BLOB)`),
    concat: source.replace(
      aggregate,
      `('[' || group_concat(${object}) || ']')`,
    ),
    "payload-limit": source
      .replace(
        'AND coalesce("__exportlite_batches"."last", 9223372036854775807)',
        "AND 9223372036854775807",
      )
      .replace('ORDER BY "rowid")', 'ORDER BY "rowid" LIMIT 256)'),
    // Diagnostic only: removing ordering is not an acceptable public change.
    "unordered-diagnostic": source
      .replace(
        `FROM (SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM`,
        "FROM",
      )
      .replace('ORDER BY "rowid")', ""),
    full,
    "full-blob": full.replace(aggregate, `CAST(${aggregate} AS BLOB)`),
  };
  const prepared = Object.fromEntries(
    Object.entries(variants).map(([name, sql]) => [
      name,
      db.prepare(sql).raw(),
    ]),
  );
  function run(name, verify = false) {
    const hash = verify ? createHash("sha256") : null;
    let bytes = 0,
      count = 0;
    if (!name.startsWith("full")) {
      hash?.update("[");
      bytes = 2;
    }
    for (const [text, rows] of prepared[name].iterate()) {
      const blob = Buffer.isBuffer(text);
      const content = name.startsWith("full")
        ? text
        : blob
          ? text.subarray(1, -1)
          : text.slice(1, -1);
      if (!name.startsWith("full") && count) {
        hash?.update(",");
        bytes++;
      }
      hash?.update(content);
      bytes += blob ? content.length : Buffer.byteLength(content);
      count += Number(rows ?? fixtures[dataset].rows);
    }
    if (!name.startsWith("full")) hash?.update("]");
    assert.equal(count, fixtures[dataset].rows);
    assert.equal(bytes, fixtures[dataset].expected.bytes);
    if (hash)
      assert.equal(hash.digest("hex"), fixtures[dataset].expected.sha256);
  }
  for (const name of Object.keys(variants)) {
    run(name, true);
    run(name);
  }
  for (let round = 0; round < 5; round++) {
    const names = Object.keys(variants);
    for (let i = 0; i < names.length; i++) {
      const name = names[(round + i) % names.length];
      const started = performance.now();
      run(name);
      observations.push({
        dataset,
        name,
        round,
        ms: performance.now() - started,
      });
    }
  }
  plans[dataset] = Object.fromEntries(
    Object.entries(variants).map(([name, sql]) => [
      name,
      { sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() },
    ]),
  );
  db.close();
}
writeFileSync(
  "benchmarks/results/remaining-gap/screen.json",
  JSON.stringify({ node: process.version, observations, plans }, null, 2),
);
for (const dataset of ["matched", "narrow", "wide"])
  for (const name of Object.keys(plans[dataset])) {
    const values = observations
      .filter((row) => row.dataset === dataset && row.name === name)
      .map((row) => row.ms)
      .sort((a, b) => a - b);
    console.log(dataset, name, values[2].toFixed(2), "ms");
  }
