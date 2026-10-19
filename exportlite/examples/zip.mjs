import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { exportTable } from "../dist/index.mjs";

const directory = new URL("./output/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = fileURLToPath(new URL(`users-${Date.now()}.zip`, directory));
const db = new Database(":memory:");
try {
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'Jóe 雪'),(2,'Amelia')",
  );
  const result = await exportTable(db, "users", {
    output,
    format: "json",
    zip: true,
  });
  console.log({ output, ...result }); // ZIP contains users.json
} finally {
  db.close();
}
