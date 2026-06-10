CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gitea_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`gitea_url` text NOT NULL,
	`username` text NOT NULL,
	`keychain_service` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_url_user` ON `gitea_accounts` (`gitea_url`,`username`);--> statement-breakpoint
CREATE TABLE `gitea_user` (
	`id` text PRIMARY KEY NOT NULL,
	`gitea_account_id` text NOT NULL,
	`gitea_user_id` integer NOT NULL,
	`login` text NOT NULL,
	`full_name` text,
	`email` text,
	`avatar_url` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`gitea_account_id`) REFERENCES `gitea_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repo_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`gitea_account_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gitea_account_id`) REFERENCES `gitea_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_account_repo` ON `repo_projects` (`gitea_account_id`,`owner`,`name`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_project_id` text NOT NULL,
	`name` text NOT NULL,
	`layout` text DEFAULT 'kanban' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo_board` ON `boards` (`repo_project_id`);--> statement-breakpoint
CREATE TABLE `board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`wip_limit` integer,
	`hide_merged_pr` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_board_pos` ON `board_columns` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`column_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`position` integer NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_col_pos` ON `cards` (`column_id`,`position`);--> statement-breakpoint
CREATE TABLE `card_links` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`gitea_ref_id` text NOT NULL,
	`role` text DEFAULT 'reference' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gitea_ref_id`) REFERENCES `gitea_refs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_card_ref` ON `card_links` (`card_id`,`gitea_ref_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_ref_card` ON `card_links` (`gitea_ref_id`,`card_id`);--> statement-breakpoint
CREATE TABLE `gitea_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`ref_id` text NOT NULL,
	`cached_title` text,
	`cached_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kind` ON `gitea_refs` (`kind`,`owner`,`repo`,`ref_id`);--> statement-breakpoint
CREATE TABLE `starred_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_project_id` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo_branch` ON `starred_branches` (`repo_project_id`,`branch`);--> statement-breakpoint
CREATE TABLE `prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_user_key` ON `prefs` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `undo_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`op` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_time` ON `undo_entries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cache_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_project_id` text,
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`ttl_seconds` integer NOT NULL,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_res_key` ON `cache_entries` (`repo_project_id`,`resource`,`key`);--> statement-breakpoint
CREATE INDEX `idx_fetched` ON `cache_entries` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `hook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_project_id` text,
	`delivery_id` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo_delivery` ON `hook_deliveries` (`repo_project_id`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_received` ON `hook_deliveries` (`received_at`);