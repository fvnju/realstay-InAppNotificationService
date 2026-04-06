CREATE TABLE `user_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`fcm_token` text NOT NULL,
	`platform` text DEFAULT 'android',
	`updated_at` integer DEFAULT 0,
	`is_active` integer DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_devices_fcm_token_unique` ON `user_devices` (`fcm_token`);--> statement-breakpoint
CREATE INDEX `user_idx` ON `user_devices` (`user_id`);