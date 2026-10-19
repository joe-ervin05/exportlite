import type { Writable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ExportResult, ExportRow, ExportStream } from "exportlite";
import { exportQuery, exportTable } from "exportlite/drizzle";
import { expectTypeOf } from "vitest";

declare const db: ReturnType<typeof drizzle>;
declare const output: Writable;
const users = sqliteTable("users", {
  id: integer().primaryKey(),
  displayName: text("name").notNull(),
  email: text(),
  active: integer({ mode: "boolean" }).notNull(),
  metadata: text({ mode: "json" }).$type<{ tags: string[] }>(),
});
const all = exportTable(db, users, { format: "json" });
expectTypeOf<ExportRow<typeof all>>().toEqualTypeOf<
  typeof users.$inferSelect
>();
const selected = exportTable(db, users, {
  columns: { userId: users.id, label: users.displayName, email: users.email },
});
type Selected = { userId: number; label: string; email: string | null };
expectTypeOf<ExportRow<typeof selected>>().toEqualTypeOf<Selected>();
const saved = exportTable(db, users, { output, zip: true });
expectTypeOf(saved).toEqualTypeOf<Promise<ExportResult>>();
const query = db
  .select({ userId: users.id, label: users.displayName, email: users.email })
  .from(users)
  .where(eq(users.active, true));
const response = exportQuery(db, query, { format: "json" });
expectTypeOf<ExportRow<typeof response>>().toEqualTypeOf<Selected>();
const raw = exportQuery(db, sql`SELECT * FROM ${users}`, {
  columns: { userId: users.id, label: users.displayName, email: users.email },
});
expectTypeOf<ExportRow<typeof raw>>().toEqualTypeOf<Selected>();
expectTypeOf(exportQuery(db, query, { output })).toEqualTypeOf<
  Promise<ExportResult>
>();
expectTypeOf(
  exportQuery(db, sql`SELECT * FROM ${users}`, {
    columns: { id: users.id },
    output,
  }),
).toEqualTypeOf<Promise<ExportResult>>();
const pets = sqliteTable("pets", {
  id: integer().primaryKey(),
  owner: integer(),
});
const joined = db
  .select({ id: users.id, petId: pets.id })
  .from(users)
  .leftJoin(pets, eq(users.id, pets.owner));
const joinedExport = exportQuery(db, joined);
expectTypeOf<ExportRow<typeof joinedExport>>().toEqualTypeOf<{
  id: number;
  petId: number | null;
}>();
const joinedStream: Promise<
  ExportStream<{ id: number; petId: number | null }>
> = exportQuery(db, joined);
void joinedStream;
// @ts-expect-error Raw SQL needs column metadata; generic SQL annotations are not runtime decoders.
exportQuery(db, sql`SELECT 1`);
// @ts-expect-error Drizzle column declarations are reused rather than strings.
exportTable(db, users, { columns: { id: "number" } });
// @ts-expect-error SQLite encodings are constrained.
exportTable(db, users, { encoding: "latin1" });
// @ts-expect-error The adapter needs a Drizzle database with a native streaming cursor.
exportTable({ $client: { execute: async () => ({ rows: [] }) } }, users);
