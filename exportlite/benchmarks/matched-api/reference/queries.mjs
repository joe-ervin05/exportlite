import { drizzle } from 'drizzle-orm/better-sqlite3';
import { asc, placeholder } from 'drizzle-orm';
import * as schema from './schema.mjs';

export const methodNames = ['revised_sql_direct', 'drizzle_relational_stringify', 'js_rows_group_stringify'];
export const labels = {
  revised_sql_direct: 'SQLite JSON',
  drizzle_relational_stringify: 'Drizzle + stringify',
  js_rows_group_stringify: 'Manual JS + stringify',
};
export const descriptions = ['Flat users', 'Users → posts', 'Users → posts → comments'];

export function createQueries(db, depth) {
  if (![0, 1, 2].includes(depth)) throw new Error('Depth must be 0, 1 or 2');
  const commentsJSON = `(
    SELECT json_group_array(json_object('body', c.body))
    FROM (SELECT body FROM comments WHERE post_id = p.id ORDER BY id) AS c
  )`;
  const postsJSON = `(
    SELECT json_group_array(json_object('title', p.title${depth === 2 ? `, 'comments', ${commentsJSON}` : ''}))
    FROM (SELECT id, title FROM posts WHERE user_id = u.id ORDER BY id) AS p
  )`;
  const revisedSQL = `SELECT json_group_array(
    json_object('name', u.name${depth > 0 ? `, 'posts', ${postsJSON}` : ''})
  ) AS data
  FROM (SELECT id, name FROM users ORDER BY id LIMIT ?) AS u`;
  const manualSQL = depth === 0
    ? 'SELECT name FROM users ORDER BY id LIMIT ?'
    : `SELECT u.id AS user_id, u.name, p.id AS post_id, p.title${depth === 2 ? ', c.id AS comment_id, c.body' : ''}
      FROM users AS u
      LEFT JOIN posts AS p ON p.user_id = u.id
      ${depth === 2 ? 'LEFT JOIN comments AS c ON c.post_id = p.id' : ''}
      WHERE u.id IN (SELECT id FROM users ORDER BY id LIMIT ?)
      ORDER BY u.id, p.id${depth === 2 ? ', c.id' : ''}`;
  const sqlStatement = db.prepare(revisedSQL);
  const rowStatement = db.prepare(manualSQL);
  const orm = drizzle(db, { schema });
  const relation = {
    columns: { title: true }, orderBy: [asc(schema.posts.id)],
    ...(depth === 2 ? { with: { comments: {
      columns: { body: true }, orderBy: [asc(schema.comments.id)],
    } } } : {}),
  };
  const drizzleQuery = orm.query.users.findMany({
    columns: { name: true }, orderBy: [asc(schema.users.id)],
    limit: placeholder('limit'),
    ...(depth > 0 ? { with: { posts: relation } } : {}),
  });
  const prepared = drizzleQuery.prepare();
  const methods = {
    revised_sql_direct(limit) { return sqlStatement.get(limit).data; },
    drizzle_relational_stringify(limit) { return JSON.stringify(prepared.all({ limit })); },
    js_rows_group_stringify(limit) {
      const rows = rowStatement.all(limit);
      if (depth === 0) return JSON.stringify(rows);
      const users = [];
      let currentUserId;
      let currentPostId;
      let currentUser;
      let currentPost;
      for (const row of rows) {
        if (row.user_id !== currentUserId) {
          currentUserId = row.user_id;
          currentPostId = undefined;
          currentUser = { name: row.name, posts: [] };
          users.push(currentUser);
        }
        if (row.post_id === null) continue;
        if (row.post_id !== currentPostId) {
          currentPostId = row.post_id;
          currentPost = depth === 1 ? { title: row.title } : { title: row.title, comments: [] };
          currentUser.posts.push(currentPost);
        }
        if (depth === 2 && row.comment_id !== null) currentPost.comments.push({ body: row.body });
      }
      return JSON.stringify(users);
    },
  };
  const drizzleSQL = drizzleQuery.toSQL();
  const plans = {
    revised_sql_direct: db.prepare(`EXPLAIN QUERY PLAN ${revisedSQL}`).all(1000),
    drizzle_relational_stringify: db.prepare(`EXPLAIN QUERY PLAN ${drizzleSQL.sql}`).all(1000),
    js_rows_group_stringify: db.prepare(`EXPLAIN QUERY PLAN ${manualSQL}`).all(1000),
  };
  return { methods, plans, sql: { revised: revisedSQL, manual: manualSQL, drizzle: drizzleSQL } };
}
