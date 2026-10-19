import assert from "node:assert/strict";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { streamExport } from "./build/engine-entry.mjs";
import { createQueries } from "./reference/queries.mjs";
import { validateEdges } from "./reference/validate.mjs";
import { batchedJsonSql, rootJsonSql } from "./root-sql.mjs";

export async function validateStreamingEdges() {
  validateEdges();
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE posts(id INTEGER PRIMARY KEY,user_id INTEGER,title TEXT);
      CREATE TABLE comments(id INTEGER PRIMARY KEY,post_id INTEGER,body TEXT);
      INSERT INTO users VALUES(1,'Jóe 雪'),(2,'Empty');
      INSERT INTO posts VALUES(1,1,'Quotes: "'),(2,1,'No comments');
      INSERT INTO comments VALUES(1,1,'line one\nline two');`);
    for (const depth of [0, 1, 2]) {
      const { methods, sql } = createQueries(db, depth);
      for (const limit of [0, 1, 10])
        for (const batched of [false, true]) {
          const chunks = [];
          const sink = new Writable({
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk));
              callback();
            },
          });
          await streamExport(
            db.prepare(
              batched
                ? batchedJsonSql(db, sql.revised)
                : rootJsonSql(sql.revised),
            ),
            batched ? [{ roots: limit }] : [limit],
            {
              output: sink,
              end: true,
              format: "json",
              bufferSize: 1,
            },
            performance.now(),
            batched,
          );
          assert.equal(
            Buffer.concat(chunks).toString("utf8"),
            methods.revised_sql_direct(limit),
          );
        }
    }
  } finally {
    db.close();
  }
}
