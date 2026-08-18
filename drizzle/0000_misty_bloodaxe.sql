CREATE TABLE `wardrobe_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color_name` text NOT NULL,
	`color_hex` text NOT NULL,
	`season` text NOT NULL,
	`style` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`image_key` text NOT NULL,
	`created_at` integer NOT NULL
);
