CREATE TABLE "calendar_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"client_id" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL
);
