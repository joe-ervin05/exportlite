import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import * as normal from "../../dist/index.mjs";

// Diagnostic only. The production build always retains its cooperative yields.
// Plain exports need no relative/package imports from this in-memory module.
const source = readFileSync(
  new URL("../../dist/index.mjs", import.meta.url),
  "utf8",
);
assert.equal(source.split("sinceYield >= 2048").length, 2);
const disabled = await import(
  `data:text/javascript;base64,${Buffer.from(source.replace("sinceYield >= 2048", "false")).toString("base64")}`
);
const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const fixture = JSON.parse(
  readFileSync("benchmarks/results/batch-profile/fixtures.json", "utf8"),
).matched;
const db = new Database(fixture.path, { readonly: true });
async function run(api, verify = false) {
  let bytes = 0;
  const hash = verify ? createHash("sha256") : null;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash?.update(chunk);
      callback();
    },
  });
  const started = performance.now();
  const result = await api.exportTable(db, "users", {
    columns: ["name"],
    format: "json",
    output: sink,
    end: true,
  });
  const ms = performance.now() - started;
  assert.equal(result.rowsExported, fixture.rows);
  assert.equal(bytes, fixture.expected.bytes);
  if (hash) assert.equal(hash.digest("hex"), fixture.expected.sha256);
  return ms;
}
await run(normal, true);
await run(disabled, true);
await run(normal);
await run(disabled);
const observations = [];
for (let round = 0; round < 10; round++) {
  const methods =
    round % 2
      ? [
          ["disabled", disabled],
          ["normal", normal],
        ]
      : [
          ["normal", normal],
          ["disabled", disabled],
        ];
  for (const [method, api] of methods)
    observations.push({ method, round, ms: await run(api) });
}
db.close();
writeFileSync(
  "benchmarks/results/remaining-gap/yield-diagnostic.json",
  JSON.stringify(
    { node: process.version, diagnosticOnly: true, observations },
    null,
    2,
  ),
);
for (const method of ["normal", "disabled"]) {
  const times = observations
    .filter((row) => row.method === method)
    .map((row) => row.ms)
    .sort((a, b) => a - b);
  console.log(method, times[5].toFixed(2), "ms");
}
