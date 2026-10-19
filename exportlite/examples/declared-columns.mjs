import Database from "better-sqlite3";
import { exportTable, integer, text } from "../dist/index.mjs";

const db = new Database(":memory:");
try {
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO users VALUES(1, 'Joe', 'joe@example.com'), (2, '雪', NULL);
  `);
  const columns = {
    id: integer().primaryKey(),
    displayName: text("name").notNull(),
    email: text(),
  };
  const stream = await exportTable(db, "users", {
    columns,
    format: "json",
  });
  const response = new Response(stream, {
    headers: { "Content-Type": "application/json" },
  });
  console.log(await response.text());
  console.log(await stream.result);
} finally {
  db.close();
}
