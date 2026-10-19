import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function ensureFixture(databasePath, roots = 1_000_000) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  if (!db.prepare("SELECT name FROM sqlite_schema WHERE name = 'fixture_metadata'").get()) {
    console.log(`Building fixture: ${roots.toLocaleString()} users, twice as many posts, four times as many comments`);
    db.exec(`
      BEGIN;
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE posts (id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);
      CREATE TABLE comments (id INTEGER PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id), body TEXT NOT NULL);
      WITH RECURSIVE seq(id) AS (
        SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${roots}
      ) INSERT INTO users SELECT id, printf('User %07d', id) FROM seq;
      WITH RECURSIVE seq(id) AS (
        SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${roots * 2}
      ) INSERT INTO posts SELECT id, ((id - 1) / 2) + 1, printf('Post %07d', id) FROM seq;
      WITH RECURSIVE seq(id) AS (
        SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${roots * 4}
      ) INSERT INTO comments SELECT id, ((id - 1) / 2) + 1, printf('Comment %07d', id) FROM seq;
      CREATE INDEX posts_user_id ON posts(user_id);
      CREATE INDEX comments_post_id ON comments(post_id);
      CREATE TABLE fixture_metadata (roots INTEGER NOT NULL, fanout INTEGER NOT NULL);
      INSERT INTO fixture_metadata VALUES (${roots}, 2);
      COMMIT;
      ANALYZE;
    `);
  }
  const metadata = db.prepare('SELECT * FROM fixture_metadata').get();
  if (metadata.roots !== roots || metadata.fanout !== 2) throw new Error('Different fixture configuration');
  const counts = {
    users: db.prepare('SELECT count(*) AS n FROM users').get().n,
    posts: db.prepare('SELECT count(*) AS n FROM posts').get().n,
    comments: db.prepare('SELECT count(*) AS n FROM comments').get().n,
  };
  if (counts.users !== roots || counts.posts !== roots * 2 || counts.comments !== roots * 4) {
    throw new Error('Incorrect fixture counts');
  }
  const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return { ...counts, fanout: 2, indexes, bytes: fs.statSync(databasePath).size };
}
