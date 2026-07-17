ALTER TABLE "transcript_utterances"
ADD COLUMN IF NOT EXISTS "audio_start_ms" integer DEFAULT 0 NOT NULL;
