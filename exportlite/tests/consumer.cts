import type { Writable } from "node:stream";

import Database = require("better-sqlite3");
import exportlite = require("exportlite");

declare const db: Database.Database;
declare const output: Writable;
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
