ALTER TABLE "transcription_sessions"
ADD COLUMN IF NOT EXISTS "processing_mode" varchar(16) DEFAULT 'realtime' NOT NULL;

ALTER TABLE "transcription_sessions"
ADD COLUMN IF NOT EXISTS "final_model_id" varchar(240);

-- Before processing modes existed, the single assignment row was still able
-- to target a batch worker. Preserve that meaning instead of leaving a legacy
-- batch assignment attached to the new realtime default.
UPDATE "transcription_sessions" AS session
SET "processing_mode" = 'batch'
FROM "transcription_assignments" AS assignment
WHERE assignment."session_id" = session."id"
  AND assignment."purpose" = 'batch'
  AND session."processing_mode" = 'realtime';

-- Expand, do not contract. Older replicas keep using transcription_assignments
-- and ON CONFLICT(session_id). New replicas use the purpose view backed by the
-- records table. The legacy table remains the first lock for mirrored rows so
-- old and new writers share the same legacy -> records lock order.
CREATE TABLE IF NOT EXISTS "transcription_assignment_records" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "transcription_assignment_records_session_purpose_idx"
ON "transcription_assignment_records" ("session_id", "purpose");
CREATE INDEX IF NOT EXISTS "transcription_assignment_records_worker_status_idx"
ON "transcription_assignment_records" ("worker_id", "status");
CREATE INDEX IF NOT EXISTS "transcription_assignment_records_lease_idx"
ON "transcription_assignment_records" ("lease_expires_at");

-- This lock closes the backfill gap: old writers that arrive after the snapshot
-- wait until the AFTER trigger and backfill are both committed.
LOCK TABLE "transcription_assignments" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION sync_legacy_assignment_to_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_mode varchar(16);
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "transcription_assignment_records"
    WHERE "session_id" = OLD."session_id" AND "purpose" = OLD."purpose";
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
  ) THEN
    SELECT "processing_mode" INTO session_mode
    FROM "transcription_sessions"
    WHERE "id" = NEW."session_id";

    -- Repair a legacy batch-first hybrid row by preserving the batch record and
    -- moving the single legacy slot to the realtime assignment with a new ID.
    IF NOT (
      session_mode = 'hybrid'
      AND OLD."session_id" = NEW."session_id"
      AND OLD."purpose" = 'batch'
      AND NEW."purpose" = 'realtime'
    ) THEN
      DELETE FROM "transcription_assignment_records"
      WHERE "session_id" = OLD."session_id" AND "purpose" = OLD."purpose";
    END IF;
  END IF;

  INSERT INTO "transcription_assignment_records" (
    "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
    "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
  ) VALUES (
    NEW."id", NEW."session_id", NEW."worker_id", NEW."model_id", NEW."purpose",
    NEW."status", NEW."message", NEW."lease_expires_at", NEW."activated_at",
    NEW."released_at", NEW."created_at", NEW."updated_at"
  )
  ON CONFLICT ("session_id", "purpose") DO UPDATE SET
    "worker_id" = EXCLUDED."worker_id",
    "model_id" = EXCLUDED."model_id",
    "status" = EXCLUDED."status",
    "message" = EXCLUDED."message",
    "lease_expires_at" = EXCLUDED."lease_expires_at",
    "activated_at" = EXCLUDED."activated_at",
    "released_at" = EXCLUDED."released_at",
    "updated_at" = EXCLUDED."updated_at";
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transcription_assignments_sync_record
ON "transcription_assignments";
CREATE TRIGGER transcription_assignments_sync_record
AFTER INSERT OR UPDATE OR DELETE ON "transcription_assignments"
FOR EACH ROW EXECUTE FUNCTION sync_legacy_assignment_to_record();

INSERT INTO "transcription_assignment_records" (
  "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
  "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
)
SELECT
  "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
  "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
FROM "transcription_assignments"
ON CONFLICT ("session_id", "purpose") DO UPDATE SET
  "worker_id" = EXCLUDED."worker_id",
  "model_id" = EXCLUDED."model_id",
  "status" = EXCLUDED."status",
  "message" = EXCLUDED."message",
  "lease_expires_at" = EXCLUDED."lease_expires_at",
  "activated_at" = EXCLUDED."activated_at",
  "released_at" = EXCLUDED."released_at",
  "updated_at" = EXCLUDED."updated_at";

CREATE OR REPLACE VIEW "transcription_assignment_purposes" AS
SELECT
  "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
  "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
FROM "transcription_assignment_records";

CREATE OR REPLACE FUNCTION write_transcription_assignment_purpose()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_mode varchar(16);
  legacy_id uuid;
  legacy_purpose varchar(20);
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
  ) THEN
    RAISE EXCEPTION 'assignment identity fields are immutable'
      USING ERRCODE = '23000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT "processing_mode" INTO session_mode
    FROM "transcription_sessions"
    WHERE "id" = OLD."session_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'transcription session does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF OLD."purpose" = 'realtime' OR (OLD."purpose" = 'batch' AND session_mode = 'batch') THEN
      DELETE FROM "transcription_assignments"
      WHERE "session_id" = OLD."session_id" AND "purpose" = OLD."purpose";
      IF NOT FOUND THEN
        DELETE FROM "transcription_assignment_records"
        WHERE "id" = OLD."id";
      END IF;
    ELSE
      DELETE FROM "transcription_assignment_records"
      WHERE "id" = OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  SELECT "processing_mode" INTO session_mode
  FROM "transcription_sessions"
  WHERE "id" = NEW."session_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transcription session does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF NOT (
    (session_mode = 'realtime' AND NEW."purpose" = 'realtime')
    OR (session_mode = 'batch' AND NEW."purpose" = 'batch')
    OR (session_mode = 'hybrid' AND NEW."purpose" IN ('realtime', 'batch'))
  ) THEN
    RAISE EXCEPTION 'assignment purpose is not valid for processing mode'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."purpose" = 'realtime' OR (NEW."purpose" = 'batch' AND session_mode = 'batch') THEN
    -- The upsert itself is the legacy-row lock. Same-purpose retries retain the
    -- canonical legacy ID. The only allowed purpose transition repairs a
    -- batch-first hybrid row and assigns realtime a distinct caller-supplied ID.
    INSERT INTO "transcription_assignments" (
      "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
      "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
    ) VALUES (
      NEW."id", NEW."session_id", NEW."worker_id", NEW."model_id", NEW."purpose",
      NEW."status", NEW."message", NEW."lease_expires_at", NEW."activated_at",
      NEW."released_at", NEW."created_at", NEW."updated_at"
    )
    ON CONFLICT ("session_id") DO UPDATE SET
      "id" = CASE
        WHEN "transcription_assignments"."purpose" = EXCLUDED."purpose"
          THEN "transcription_assignments"."id"
        ELSE EXCLUDED."id"
      END,
      "worker_id" = EXCLUDED."worker_id",
      "model_id" = EXCLUDED."model_id",
      "purpose" = EXCLUDED."purpose",
      "status" = EXCLUDED."status",
      "message" = EXCLUDED."message",
      "lease_expires_at" = EXCLUDED."lease_expires_at",
      "activated_at" = EXCLUDED."activated_at",
      "released_at" = EXCLUDED."released_at",
      "updated_at" = EXCLUDED."updated_at"
    WHERE "transcription_assignments"."purpose" = EXCLUDED."purpose"
       OR (
         session_mode = 'hybrid'
         AND "transcription_assignments"."purpose" = 'batch'
         AND EXCLUDED."purpose" = 'realtime'
       )
    RETURNING "id", "purpose" INTO legacy_id, legacy_purpose;

    IF legacy_id IS NULL OR legacy_purpose <> NEW."purpose" THEN
      RAISE EXCEPTION 'legacy assignment purpose conflicts with processing mode'
        USING ERRCODE = '23505';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO "transcription_assignment_records" (
      "id", "session_id", "worker_id", "model_id", "purpose", "status", "message",
      "lease_expires_at", "activated_at", "released_at", "created_at", "updated_at"
    ) VALUES (
      NEW."id", NEW."session_id", NEW."worker_id", NEW."model_id", NEW."purpose",
      NEW."status", NEW."message", NEW."lease_expires_at", NEW."activated_at",
      NEW."released_at", NEW."created_at", NEW."updated_at"
    )
    ON CONFLICT ("session_id", "purpose") DO NOTHING;
  ELSE
    UPDATE "transcription_assignment_records" SET
      "worker_id" = NEW."worker_id",
      "model_id" = NEW."model_id",
      "status" = NEW."status",
      "message" = NEW."message",
      "lease_expires_at" = NEW."lease_expires_at",
      "activated_at" = NEW."activated_at",
      "released_at" = NEW."released_at",
      "updated_at" = NEW."updated_at"
    WHERE "id" = OLD."id";
  END IF;

  SELECT
    record."id", record."session_id", record."worker_id", record."model_id",
    record."purpose", record."status", record."message", record."lease_expires_at",
    record."activated_at", record."released_at", record."created_at", record."updated_at"
  INTO
    NEW."id", NEW."session_id", NEW."worker_id", NEW."model_id",
    NEW."purpose", NEW."status", NEW."message", NEW."lease_expires_at",
    NEW."activated_at", NEW."released_at", NEW."created_at", NEW."updated_at"
  FROM "transcription_assignment_records" AS record
  WHERE record."session_id" = NEW."session_id" AND record."purpose" = NEW."purpose";

  IF NEW."id" IS NULL THEN
    RAISE EXCEPTION 'assignment record was not written'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transcription_assignment_purposes_write
ON "transcription_assignment_purposes";
CREATE TRIGGER transcription_assignment_purposes_write
INSTEAD OF INSERT OR UPDATE OR DELETE ON "transcription_assignment_purposes"
FOR EACH ROW EXECUTE FUNCTION write_transcription_assignment_purpose();

-- Contract (a later release only): remove the view trigger, legacy trigger and
-- legacy table after both the mixed-version and rollback windows are closed.
