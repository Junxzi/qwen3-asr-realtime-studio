CREATE TABLE IF NOT EXISTS "inference_workers" (
  "id" varchar(160) PRIMARY KEY NOT NULL,
  "pod_id" varchar(160) DEFAULT '' NOT NULL,
  "name" varchar(200) NOT NULL,
  "service_url" text NOT NULL,
  "model_id" varchar(240) NOT NULL,
  "runtime" varchar(20) NOT NULL,
  "origin" varchar(20) DEFAULT 'static' NOT NULL,
  "status" varchar(24) NOT NULL,
  "max_sessions" integer NOT NULL,
  "active_sessions" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "gpu" jsonb,
  "health" jsonb,
  "last_heartbeat_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "transcription_assignments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "transcription_sessions"("id") ON DELETE cascade,
  "worker_id" varchar(160) REFERENCES "inference_workers"("id") ON DELETE set null,
  "model_id" varchar(240) NOT NULL,
  "purpose" varchar(20) NOT NULL,
  "status" varchar(24) NOT NULL,
  "message" text,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "activated_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "inference_workers_scheduler_idx" ON "inference_workers" ("enabled", "status", "model_id", "runtime");
CREATE UNIQUE INDEX IF NOT EXISTS "transcription_assignments_session_idx" ON "transcription_assignments" ("session_id");
CREATE INDEX IF NOT EXISTS "transcription_assignments_worker_status_idx" ON "transcription_assignments" ("worker_id", "status");
CREATE INDEX IF NOT EXISTS "transcription_assignments_lease_idx" ON "transcription_assignments" ("lease_expires_at");
