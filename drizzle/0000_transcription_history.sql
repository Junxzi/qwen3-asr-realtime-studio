CREATE TABLE IF NOT EXISTS "transcription_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "title" varchar(160) NOT NULL,
  "title_customized" boolean DEFAULT false NOT NULL,
  "status" varchar(24) NOT NULL,
  "source" varchar(20) NOT NULL,
  "model_id" varchar(240) NOT NULL,
  "catalog_revision" varchar(240) DEFAULT '' NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone NOT NULL,
  "duration_ms" integer,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "transcript_utterances" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "transcription_sessions"("id") ON DELETE cascade,
  "utterance_id" varchar(160) NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "sequence" integer NOT NULL,
  "speaker" varchar(80) NOT NULL,
  "text" text NOT NULL,
  "words" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "context_hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "audio_end_ms" integer DEFAULT 0 NOT NULL,
  "latency_ms" double precision,
  "queue_ms" double precision,
  "rtf" double precision,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "transcription_sessions_started_idx" ON "transcription_sessions" ("started_at");
CREATE INDEX IF NOT EXISTS "transcription_sessions_expires_idx" ON "transcription_sessions" ("expires_at");
CREATE INDEX IF NOT EXISTS "transcription_sessions_title_idx" ON "transcription_sessions" ("title");
CREATE UNIQUE INDEX IF NOT EXISTS "transcript_utterances_session_utterance_idx" ON "transcript_utterances" ("session_id", "utterance_id");
CREATE UNIQUE INDEX IF NOT EXISTS "transcript_utterances_session_sequence_idx" ON "transcript_utterances" ("session_id", "sequence");
