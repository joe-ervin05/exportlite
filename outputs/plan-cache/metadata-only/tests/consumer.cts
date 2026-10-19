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
