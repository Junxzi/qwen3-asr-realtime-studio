CREATE UNIQUE INDEX IF NOT EXISTS "inference_workers_pod_id_unique_idx"
ON "inference_workers" ("pod_id")
WHERE "pod_id" <> '';
