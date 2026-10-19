import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql/http";
import {
  integer as int,
  sqliteTable,
  text as str,
} from "drizzle-orm/sqlite-core";
import { integer, text } from "exportlite";
import { exportQuery as exportDrizzleQuery } from "exportlite/drizzle";
import { createClient, exportTable } from "exportlite/turso";

// Point at an existing database with users(id INTEGER PRIMARY KEY, name TEXT,
// active INTEGER). This example reads it; it does not create or modify tables.
const url = process.env.TURSO_DATABASE_URL;
if (!url)
  throw new Error("Set TURSO_DATABASE_URL to an existing database URL.");
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  const stream = await exportTable(client, "users", {
    columns: {
      id: integer().primaryKey(),
      name: text(),
      active: integer({ mode: "boolean" }),
    },
    format: "json",
  });
  console.log(await new Response(stream).text());
  await stream.result;

  const users = sqliteTable("users", {
    id: int().primaryKey(),
    name: str(),
    active: int({ mode: "boolean" }),
  });
  const db = drizzle(client);
  const query = db
    .select({ id: users.id, label: users.name })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(users.id)
    .limit(2);
  const selected = await exportDrizzleQuery(db, query, { format: "json" });
  console.log(await new Response(selected).text());
  await selected.result;
} finally {
  await client.close();
}
