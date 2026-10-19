import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { planBatchedTable } from "../matched-api/build/engine-entry.mjs";

const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const fixtures = JSON.parse(
  readFileSync("benchmarks/results/batch-profile/fixtures.json", "utf8"),
);
const results = [];
for (const dataset of ["matched", "narrow", "wide"]) {
  const db = new Database(fixtures[dataset].path, { readonly: true });
  const table = dataset === "matched" ? "users" : "data";
  const columns =
    dataset === "matched" ? ["name"] : ["id", "name", "note", "active"];
  const object = `json_object(${columns.map((name) => `'${name}', "${name}"`).join(", ")})`;
  const source = planBatchedTable(db, {
    table,
    columns,
    columnNames: columns,
    format: "json",
  }).source;
  const ordered = source
    .replace(
      `json_group_array(${object})`,
      `json_group_array(${object} ORDER BY "rowid")`,
    )
    .replace(
      `FROM (SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM`,
      "FROM",
    )
    .replace('ORDER BY "rowid")\n  )', "\n  )");
  const variants = { current: source, ordered };
  const statements = Object.fromEntries(
    Object.entries(variants).map(([name, sql]) => [
      name,
      db.prepare(sql).raw(),
    ]),
  );
  function run(name, verify = false) {
    const hash = verify ? createHash("sha256") : null;
    let rows = 0;
    hash?.update("[");
    for (const [bytes, count] of statements[name].iterate()) {
      if (rows) hash?.update(",");
      hash?.update(bytes.subarray(1, -1));
      rows += count;
    }
    hash?.update("]");
    assert.equal(rows, fixtures[dataset].rows);
    if (hash)
      assert.equal(hash.digest("hex"), fixtures[dataset].expected.sha256);
  }
  run("current", true);
  run("ordered", true);
  const observations = [];
  for (let round = 0; round < 5; round++)
    for (const name of round % 2
      ? ["ordered", "current"]
      : ["current", "ordered"]) {
      const started = performance.now();
      run(name);
      observations.push({ name, round, ms: performance.now() - started });
    }
  results.push({
    dataset,
    observations,
    plans: Object.fromEntries(
      Object.entries(variants).map(([name, sql]) => [
        name,
        { sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() },
      ]),
    ),
  });
  for (const name of ["current", "ordered"])
    console.log(
      dataset,
      name,
      observations
        .filter((row) => row.name === name)
        .map((row) => row.ms)
        .sort((a, b) => a - b)[2]
        .toFixed(2),
    );
  db.close();
}
writeFileSync(
  "benchmarks/results/remaining-gap/aggregate-order.json",
  JSON.stringify(results, null, 2),
);
