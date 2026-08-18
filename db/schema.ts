import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const wardrobeItems = sqliteTable("wardrobe_items", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  colorName: text("color_name").notNull(),
  colorHex: text("color_hex").notNull(),
  season: text("season").notNull(),
  style: text("style").notNull(),
  status: text("status").notNull().default("available"),
  aiTags: text("ai_tags").notNull().default("{}"),
  tagVersion: integer("tag_version").notNull().default(0),
  imageKey: text("image_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [index("idx_wardrobe_items_owner_created").on(table.ownerId, table.createdAt)]);
