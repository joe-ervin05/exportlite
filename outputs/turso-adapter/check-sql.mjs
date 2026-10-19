import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  `${root}exportlite/benchmarks/matched-api/package.json`,
);
const Database = require("better-sqlite3");
const core = await import(`${root}exportlite/dist/index.mjs`);
const adapter = await import(`${root}exportlite/dist/drizzle.mjs`);
const { drizzle } = await import(
  `${root}exportlite/node_modules/drizzle-orm/better-sqlite3/index.js`
);
const { sqliteTable, integer, text } = await import(
  `${root}exportlite/node_modules/drizzle-orm/sqlite-core/index.js`
);
const table = sqliteTable("data", {
  id: integer().primaryKey(),
  name: text(),
  note: text(),
  active: integer(),
});
const selected = {
  id: table.id,
  name: table.name,
  note: table.note,
  active: table.active,
};
const declared = {
  id: core.integer().primaryKey(),
  name: core.text(),
  note: core.text(),
  active: core.integer(),
};

async function capture(method) {
  const client = new Database(":memory:");
  client.exec("CREATE TABLE data(id INTEGER PRIMARY KEY, name TEXT, note TEXT, active INTEGER)");
  const prepare = client.prepare.bind(client);
  const statements = [];
  client.prepare = (sql) => {
    statements.push(sql);
    return prepare(sql);
  };
  try {
    const stream =
      method === "direct"
        ? await core.exportTable(client, "data", {
            columns: declared,
            format: "json",
          })
        : await adapter.exportTable(drizzle(client), table, {
            columns: selected,
            format: "json",
          });
    await stream.cancel("SQL-only verification");
    await assert.rejects(stream.result, { code: "ABORTED" });
    assert.equal(statements.length, 1);
    assert.match(statements[0], /RECURSIVE/);
    return statements[0];
  } finally {
    client.close();
  }
}
const direct = await capture("direct");
const viaDrizzle = await capture("adapter");
assert.equal(direct, viaDrizzle);
const previous = JSON.parse(readFileSync(new URL("../drizzle-adapter-benchmark/sql-validation.json", import.meta.url), "utf8"));
assert.equal(direct, previous.sql);
writeFileSync(
  new URL("./sql-validation.json", import.meta.url),
  `${JSON.stringify(
    {
      passed: true,
      preparedStatementsPerMethod: 1,
      identicalSql: true,
      matchesPreviousNativeSql: true,
      sha256: createHash("sha256").update(direct).digest("hex"),
      sql: direct,
    },
    null,
    2,
  )}\n`,
);
console.log("Native direct and Drizzle exports still prepare exactly the prior batched SQL, one statement each.");
