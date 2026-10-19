import { relations } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(), name: text('name').notNull(),
});
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
});
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey(),
  postId: integer('post_id').notNull().references(() => posts.id),
  body: text('body').notNull(),
});
export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one, many }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
  comments: many(comments),
}));
export const commentsRelations = relations(comments, ({ one }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
}));
