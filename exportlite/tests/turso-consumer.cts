import type { Writable } from "node:stream";
import type { Client } from "@libsql/client/http";

import orm = require("drizzle-orm");
const { eq } = orm;
import driver = require("drizzle-orm/libsql/http");
const { drizzle } = driver;
import sqlite = require("drizzle-orm/sqlite-core");
const { integer: int, sqliteTable, text: str } = sqlite;

import type { ExportResult, ExportRow } from "exportlite";

import core = require("exportlite");
const { integer, text } = core;
import adapter = require("exportlite/drizzle");
const { exportQuery: drizzleQuery, exportTable: drizzleTable } = adapter;
import remote = require("exportlite/turso");
const { createClient, exportQuery, exportTable } = remote;
import vitest = require("vitest");
const { expectTypeOf } = vitest;

declare const output: Writable;
const client = createClient({
  url: "libsql://test.turso.io",
  intMode: "bigint",
});
const ordinary: Client = client;
void ordinary;
expectTypeOf(client.close()).toEqualTypeOf<Promise<void>>();
const direct = exportTable(client, "users", {
  columns: { id: integer().primaryKey(), name: text() },
  format: "json",
});
expectTypeOf<ExportRow<typeof direct>>().toEqualTypeOf<{
  id: number;
  name: string | null;
}>();
const raw = exportQuery(client, {
  sql: "SELECT id,name FROM users WHERE id>?",
  params: [1n],
  columns: { id: integer().notNull(), label: text("name") },
});
expectTypeOf<ExportRow<typeof raw>>().toEqualTypeOf<{
  id: number;
  label: string | null;
}>();
expectTypeOf(
  exportTable(client, "users", {
    columns: { id: integer() },
    output,
    zip: true,
  }),
).toEqualTypeOf<Promise<ExportResult>>();
const users = sqliteTable("users", {
  id: int().primaryKey(),
  name: str(),
  active: int({ mode: "boolean" }).notNull(),
});
const db = drizzle(client);
const table = drizzleTable(db, users, { format: "json", zip: true });
expectTypeOf<ExportRow<typeof table>>().toEqualTypeOf<
  typeof users.$inferSelect
>();
const selected = drizzleQuery(
  db,
  db
    .select({ userId: users.id, label: users.name })
    .from(users)
    .where(eq(users.active, true)),
);
expectTypeOf<ExportRow<typeof selected>>().toEqualTypeOf<{
  userId: number;
  label: string | null;
}>();
// @ts-expect-error Remote schemas are declared to avoid preflight queries.
exportTable(client, "users");
// @ts-expect-error Remote queries need result metadata.
exportQuery(client, { sql: "SELECT 1" });
// @ts-expect-error Discovery arrays are not remote column declarations.
exportTable(client, "users", { columns: ["id"] });
// @ts-expect-error Turso transmits JSON text, so SQLite byte-encoding hints are unnecessary.
exportTable(client, "users", { columns: { id: integer() }, encoding: "utf8" });
