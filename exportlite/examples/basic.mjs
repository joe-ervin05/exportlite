import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { exportQuery, exportTable } from "../dist/index.mjs";

const db = new Database(":memory:");
db.exec(
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER); INSERT INTO users VALUES (1, 'Ada', 1), (2, 'Grace', 0)",
);
await mkdir(new URL("./output/", import.meta.url), { recursive: true });
const output = fileURLToPath(
  new URL(`./output/users-${Date.now()}.json`, import.meta.url),
);
try {
  console.log(await exportTable(db, "users", { format: "json", output }));
  console.log(`Created ${output}`);
  await exportQuery(db, {
    sql: "SELECT id, name FROM users WHERE active = ? ORDER BY id",
    params: [1],
    output: process.stdout,
  });
} finally {
  db.close();
}
