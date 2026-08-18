ALTER TABLE `wardrobe_items` ADD `ai_tags` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `wardrobe_items` ADD `tag_version` integer DEFAULT 0 NOT NULL;