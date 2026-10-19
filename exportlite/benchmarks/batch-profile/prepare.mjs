import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createFixture } from "../fixture.mjs";

const temporary = "<temporary>/exportlite-batch-profile-20261017";
mkdirSync(temporary, { recursive: true });
const fixtures = {};
for (const dataset of ["matched", "narrow", "wide"]) {
  const path =
    dataset === "matched"
      ? "<temporary>/exportlite-matched-api-20261017/fixture.db"
      : `${temporary}/${dataset}.db`;
  const rows = dataset === "wide" ? 100_000 : 1_000_000;
  const width = dataset === "wide" ? 1024 : 32;
  const metadata =
    dataset !== "matched" && !existsSync(path)
      ? createFixture(path, rows, { width, profile: "varied", seed: 20261017 })
      : undefined;
  const db = new Database(path, { readonly: true });
  const columns =
    dataset === "matched" ? ["name"] : ["id", "name", "note", "active"];
  const table = dataset === "matched" ? "users" : "data";
  const text = db
    .prepare(
      `SELECT json_group_array(json_object(${columns.map((name) => `'${name}', "${name}"`).join(",")})) FROM (SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM main."${table}" ORDER BY rowid)`,
    )
    .pluck()
    .get();
  fixtures[dataset] = {
    path,
    rows,
    width: dataset === "matched" ? null : width,
    profile: dataset === "matched" ? "original ASCII labels" : "varied",
    seed: dataset === "matched" ? null : 20261017,
    metadata,
    fixtureSha256: createHash("sha256")
      .update(readFileSync(path))
      .digest("hex"),
    expected: {
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
  db.close();
  console.log(`${dataset}: ${fixtures[dataset].expected.bytes} JSON bytes`);
}
writeFileSync(
  "benchmarks/results/batch-profile/fixtures.json",
  `${JSON.stringify(fixtures, null, 2)}\n`,
);
