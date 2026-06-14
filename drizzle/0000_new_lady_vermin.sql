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
CREATE TABLE `board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_project_id` text NOT NULL,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_pos` ON `board_columns` (`repo_project_id`,`position`);--> statement-breakpoint
CREATE TABLE `column_label_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`column_id` text NOT NULL,
	`repo_project_id` text NOT NULL,
	`gitea_label_id` text NOT NULL,
	`gitea_label_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_project_id`) REFERENCES `repo_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_label` ON `column_label_mapping` (`repo_project_id`,`gitea_label_id`);--> statement-breakpoint
CREATE INDEX `idx_column` ON `column_label_mapping` (`column_id`);--> statement-breakpoint
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
CREATE INDEX `idx_fetched` ON `cache_entries` (`fetched_at`);