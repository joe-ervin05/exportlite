import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createQueries } from './queries.mjs';

export function validateEdges() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE INDEX posts_user_id ON posts(user_id);
    CREATE INDEX comments_post_id ON comments(post_id);
    INSERT INTO users VALUES (1, 'First'), (2, 'Empty'), (3, 'Last');
    INSERT INTO posts VALUES (1, 1, 'One'), (2, 1, 'No comments'), (3, 3, 'Three');
    INSERT INTO comments VALUES (1, 1, 'One'), (2, 1, 'Two'), (3, 3, 'Three');
  `);
  const special = 'Quotes: " \\ newline:\n café 🦦';
  db.prepare('UPDATE comments SET body = ? WHERE id = 1').run(special);
  for (const depth of [0, 1, 2]) {
    const { methods } = createQueries(db, depth);
    const reference = methods.revised_sql_direct(10);
    for (const fn of Object.values(methods)) {
      assert.equal(fn(10), reference);
      assert.equal(fn(0), '[]');
      assert.equal(JSON.parse(fn(1)).length, 1);
    }
    const parsed = JSON.parse(reference);
    if (depth > 0) assert.deepEqual(parsed[1].posts, []);
    if (depth === 2) {
      assert.deepEqual(parsed[0].posts[1].comments, []);
      assert.equal(parsed[0].posts[0].comments[0].body, special);
    }
  }
  db.close();
}
