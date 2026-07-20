CREATE TABLE "harness_transcript_entries" (
	"project_key" text NOT NULL,
	"sdk_session_id" text NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"ord" bigserial PRIMARY KEY,
	"entry_uuid" text,
	"entry" jsonb NOT NULL,
	"namespace" text NOT NULL,
	"funky_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "runtime" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "harness_attempt" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "harness_state" jsonb;--> statement-breakpoint
CREATE INDEX "harness_entries_key" ON "harness_transcript_entries" ("project_key","sdk_session_id","subpath","ord");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_entries_dedupe" ON "harness_transcript_entries" ("sdk_session_id","subpath","entry_uuid") WHERE "entry_uuid" is not null;--> statement-breakpoint
CREATE INDEX "harness_entries_session" ON "harness_transcript_entries" ("funky_session_id","ord");--> statement-breakpoint
ALTER TABLE "harness_transcript_entries" ADD CONSTRAINT "harness_transcript_entries_funky_session_id_sessions_id_fkey" FOREIGN KEY ("funky_session_id") REFERENCES "sessions"("id");