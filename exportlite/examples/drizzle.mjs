import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { exportQuery, exportTable } from "../dist/drizzle.mjs";

const users = sqliteTable("users", {
  id: integer().primaryKey(),
  displayName: text("name").notNull(),
  active: integer({ mode: "boolean" }).notNull(),
});
const client = new Database(":memory:");
const db = drizzle(client);
try {
  client.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL)",
  );
  db.insert(users)
    .values([
      { id: 1, displayName: "Joe", active: true },
      { id: 2, displayName: "雪", active: false },
    ])
    .run();

  // Reuse the existing schema, including its primary key and boolean mode.
  const table = await exportTable(db, users, { format: "json" });
  console.log(await new Response(table).text());
  await table.result;

  // Compile this query without fetching or mapping Drizzle row objects.
  const query = db
    .select({ userId: users.id, label: users.displayName })
    .from(users)
    .where(eq(users.active, true));
  const selected = await exportQuery(db, query, { format: "json" });
  console.log(await new Response(selected).text());
  await selected.result;

  // Raw SQL templates retain parameter binding; reuse columns as metadata.
  const raw = await exportQuery(
    db,
    sql`SELECT * FROM ${users} WHERE ${users.id} = ${2}`,
    {
      columns: { label: users.displayName, enabled: users.active },
      format: "json",
    },
  );
  console.log(await new Response(raw).text());
  await raw.result;
} finally {
  client.close();
}
