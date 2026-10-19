import type { Writable } from "node:stream";

import Database = require("better-sqlite3");
import exportlite = require("exportlite");

declare const db: Database.Database;
declare const output: Writable;
const readable: Promise<exportlite.ExportStream> = exportlite.exportTable(
  db,
  "users",
  { zip: true },
);
void readable;
const response: Promise<Response> = readable.then(
  (stream) => new Response(stream),
);
void response;
const declared = exportlite.exportTable(db, "users", {
  columns: {
    userId: exportlite.integer("id").primaryKey(),
    name: exportlite.text(),
  },
});
type User = exportlite.ExportRow<typeof declared>;
const user: User = { userId: 1, name: null };
// @ts-expect-error The non-null integer selection remains a number.
const invalid: User = { userId: "wrong", name: null };
void user;
void invalid;
const result: Promise<exportlite.ExportResult> = exportlite.exportTable(
  db,
  "users",
  {
    output,
    format: "jsonl",
    zip: true,
  },
);
export = result;
