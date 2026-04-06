import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const userDevices = sqliteTable('user_devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  fcmToken: text('fcm_token').notNull().unique(),
  platform: text('platform').default('android'),
  updatedAt: integer('updated_at').default(0),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
}, (table) => ({
  userIdx: index('user_idx').on(table.userId),
}));

export type UserDevice = typeof userDevices.$inferSelect;
