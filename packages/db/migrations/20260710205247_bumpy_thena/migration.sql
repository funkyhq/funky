CREATE TABLE "agent_config_versions" (
	"agent_config_id" uuid,
	"version" integer,
	"namespace" text NOT NULL,
	"system_prompt" text NOT NULL,
	"model" jsonb NOT NULL,
	"tool_policy" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "agent_config_versions_pkey" PRIMARY KEY("agent_config_id","version")
);
--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "agent_configs_ns_name" ON "agent_configs" ("namespace","name");--> statement-breakpoint
CREATE INDEX "agent_configs_ns" ON "agent_configs" ("namespace");--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_agent_config_id_agent_configs_id_fkey" FOREIGN KEY ("agent_config_id") REFERENCES "agent_configs"("id");