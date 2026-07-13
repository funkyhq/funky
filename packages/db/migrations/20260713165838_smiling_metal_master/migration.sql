CREATE TABLE "session_events" (
	"session_id" uuid,
	"seq" bigint,
	"namespace" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_pkey" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY,
	"namespace" text NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"agent_version" integer NOT NULL,
	"env_config_id" uuid NOT NULL,
	"resolved_env" jsonb,
	"sandbox_handle" jsonb,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"title" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turn_jobs" (
	"id" uuid PRIMARY KEY,
	"namespace" text NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text DEFAULT 'turn' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sessions_ns" ON "sessions" ("namespace");--> statement-breakpoint
CREATE INDEX "turn_jobs_queued" ON "turn_jobs" ("run_at") WHERE "state" = 'queued';--> statement-breakpoint
CREATE INDEX "turn_jobs_active_session" ON "turn_jobs" ("session_id") WHERE "state" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_config_id_agent_configs_id_fkey" FOREIGN KEY ("agent_config_id") REFERENCES "agent_configs"("id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_env_config_id_env_configs_id_fkey" FOREIGN KEY ("env_config_id") REFERENCES "env_configs"("id");--> statement-breakpoint
ALTER TABLE "turn_jobs" ADD CONSTRAINT "turn_jobs_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");