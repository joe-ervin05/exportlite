import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { exportTable } from "../../dist/index.mjs";
import { createQueries } from "../matched-api/reference/queries.mjs";
import { batchedJsonSql } from "../matched-api/root-sql.mjs";
import { readZip } from "../read-zip.mjs";

const require = createRequire(
  new URL("../matched-api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const directory = "benchmarks/results/remaining-gap";
const fixtures = JSON.parse(
  readFileSync("benchmarks/results/batch-profile/fixtures.json", "utf8"),
);
const nested = [];
const db = new Database(fixtures.matched.path, { readonly: true });
for (const depth of [0, 1, 2]) {
  const queries = createQueries(db, depth);
  const statement = db.prepare(batchedJsonSql(db, queries.sql.revised)).raw();
  for (const roots of [0, 1, 255, 256, 257, 513, 10000]) {
    const batches = [...statement.iterate({ roots })];
    const text = `[${batches.map(([text]) => text.slice(1, -1)).join(",")}]`;
    assert.equal(text, queries.methods.revised_sql_direct(roots));
    assert.equal(
      batches.reduce((sum, [, count]) => sum + Number(count), 0),
      roots,
    );
    nested.push({ depth, roots, batches: batches.length, matches: true });
  }
}
db.close();
const zip = [];
for (const dataset of ["narrow", "wide"]) {
  const fixture = fixtures[dataset];
  const connection = new Database(fixture.path, { readonly: true });
  const output = `<temporary>/exportlite-batch-profile-20261017/validate-${dataset}.zip`;
  try {
    const result = await exportTable(connection, "data", {
      format: "json",
      output,
      zip: true,
    });
    const decoded = await readZip(output, { name: "data.json" });
    assert.equal(decoded.bytes, fixture.expected.bytes);
    assert.equal(decoded.sha256, fixture.expected.sha256);
    assert.equal(result.rowsExported, fixture.rows);
    zip.push({ dataset, ...decoded, encodedBytes: result.bytesWritten });
  } finally {
    connection.close();
    rmSync(output, { force: true });
  }
}
writeFileSync(
  `${directory}/validation.json`,
  `${JSON.stringify({ node: process.version, nested, zip }, null, 2)}\n`,
);
console.log(
  `Validated ${nested.length} nested adapter cases and ${zip.length} complete ZIPs with CRC and SHA-256`,
);
