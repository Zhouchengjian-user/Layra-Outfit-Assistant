CREATE TABLE `model_profiles` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`image_key` text NOT NULL,
	`content_type` text NOT NULL,
	`quality` text DEFAULT 'ready' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
