import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { exportTable } from "../dist/index.mjs";

const db = new Database(":memory:");
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
  WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
  INSERT INTO users SELECT x, 'User ' || x FROM n`);
await mkdir(new URL("./output/", import.meta.url), { recursive: true });
const output = fileURLToPath(
  new URL(`./output/batched-${Date.now()}.json`, import.meta.url),
);
try {
  const stats = await exportTable(db, "users", {
    format: "json",
    output,
  });
  console.log(stats);
  console.log(`Created ${output}`);
} finally {
  db.close();
}
