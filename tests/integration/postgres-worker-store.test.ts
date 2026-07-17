import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AppConfig } from "../../server/config.js";
import { PostgresTranscriptionStore } from "../../server/postgres-store.js";
import { runRetentionMaintenance } from "../../server/transcriptions.js";
import { PostgresWorkerPoolStore } from "../../server/worker-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the Postgres integration suite");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const transcriptions = new PostgresTranscriptionStore(databaseUrl);
const workers = new PostgresWorkerPoolStore(databaseUrl);

async function createSession(now: Date, processingMode: "realtime" | "hybrid" = "realtime") {
  const id = randomUUID();
  await transcriptions.create({
    id,
    source: "microphone",
    processingMode,
    modelId: "model-a",
    finalModelId: processingMode === "hybrid" ? "model-final" : null,
    catalogRevision: "catalog-test",
    now,
    retentionDays: 30,
  });
  return id;
}

function databaseUrlFor(applicationName: string) {
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function waitForLock(applicationName: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'
      ) AS waiting
    `, [applicationName]);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${applicationName} to block on a row lock`);
}

describe("Postgres worker pool", () => {
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE transcription_assignment_records, transcription_assignments, inference_workers, transcript_utterances, transcription_sessions CASCADE",
    );
  });

  afterAll(async () => {
    await Promise.all([workers.close(), transcriptions.close(), pool.end()]);
  });

  it("applies the worker migration and reports the store healthy", async () => {
    await expect(workers.health()).resolves.toEqual({ ready: true });
    const relations = await pool.query<{ relname: string; relkind: string }>(`
      SELECT relname, relkind FROM pg_class
      WHERE relname IN ('transcription_assignment_records', 'transcription_assignment_purposes')
      ORDER BY relname
    `);
    expect(relations.rows).toEqual([
      { relname: "transcription_assignment_purposes", relkind: "v" },
      { relname: "transcription_assignment_records", relkind: "r" },
    ]);
  });

  it("backfills legacy assignments and keeps the writable view mirrored", async () => {
    const client = await pool.connect();
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    try {
      await client.query(`CREATE SCHEMA ${quotedSchema}`);
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      await client.query(`
        CREATE TABLE transcription_sessions (
          id uuid PRIMARY KEY
        );
        CREATE TABLE inference_workers (
          id varchar(160) PRIMARY KEY
        );
        CREATE TABLE transcription_assignments (
          id uuid PRIMARY KEY,
          session_id uuid NOT NULL UNIQUE REFERENCES transcription_sessions(id) ON DELETE CASCADE,
          worker_id varchar(160) REFERENCES inference_workers(id) ON DELETE SET NULL,
          model_id varchar(240) NOT NULL,
          purpose varchar(20) NOT NULL,
          status varchar(24) NOT NULL,
          message text,
          lease_expires_at timestamp with time zone NOT NULL,
          activated_at timestamp with time zone,
          released_at timestamp with time zone,
          created_at timestamp with time zone NOT NULL,
          updated_at timestamp with time zone NOT NULL
        )
      `);
      const sessionId = randomUUID();
      const assignmentId = randomUUID();
      const batchSessionId = randomUUID();
      const batchAssignmentId = randomUUID();
      const now = new Date("2026-07-17T00:00:00.000Z");
      await client.query(
        `INSERT INTO transcription_sessions (id) VALUES ($1), ($2)`,
        [sessionId, batchSessionId],
      );
      await client.query(`
        INSERT INTO transcription_assignments (
          id, session_id, worker_id, model_id, purpose, status, message,
          lease_expires_at, activated_at, released_at, created_at, updated_at
        ) VALUES ($1, $2, null, 'model-a', 'realtime', 'requested', 'before migration', $3, null, null, $4, $4)
      `, [assignmentId, sessionId, new Date(now.getTime() + 900_000), now]);
      await client.query(`
        INSERT INTO transcription_assignments (
          id, session_id, worker_id, model_id, purpose, status, message,
          lease_expires_at, activated_at, released_at, created_at, updated_at
        ) VALUES ($1, $2, null, 'model-batch', 'batch', 'requested', 'legacy batch', $3, null, null, $4, $4)
      `, [batchAssignmentId, batchSessionId, new Date(now.getTime() + 900_000), now]);

      const migrationSql = await readFile(
        new URL("../../drizzle/0003_processing_modes.sql", import.meta.url),
        "utf8",
      );
      await client.query(migrationSql);

      const backfilled = await client.query<{ id: string; message: string }>(`
        SELECT id, message FROM transcription_assignment_records
        WHERE session_id = $1 AND purpose = 'realtime'
      `, [sessionId]);
      expect(backfilled.rows).toEqual([{ id: assignmentId, message: "before migration" }]);
      const migratedBatch = await client.query<{ processing_mode: string; assignment_id: string }>(`
        SELECT session.processing_mode, assignment.id AS assignment_id
        FROM transcription_sessions AS session
        JOIN transcription_assignment_purposes AS assignment ON assignment.session_id = session.id
        WHERE session.id = $1 AND assignment.purpose = 'batch'
      `, [batchSessionId]);
      expect(migratedBatch.rows).toEqual([{
        processing_mode: "batch",
        assignment_id: batchAssignmentId,
      }]);
      await expect(client.query(`
        UPDATE transcription_assignment_purposes
        SET message = 'batch view update', updated_at = $2
        WHERE session_id = $1 AND purpose = 'batch'
      `, [batchSessionId, new Date(now.getTime() + 1)])).resolves.toBeDefined();

      await client.query(`
        UPDATE transcription_assignments SET message = 'legacy update'
        WHERE session_id = $1
      `, [sessionId]);
      const mirroredLegacy = await client.query<{ message: string }>(`
        SELECT message FROM transcription_assignment_records
        WHERE session_id = $1 AND purpose = 'realtime'
      `, [sessionId]);
      expect(mirroredLegacy.rows).toEqual([{ message: "legacy update" }]);

      const returnedUpdate = await client.query<{ id: string; status: string; message: string }>(`
        UPDATE transcription_assignment_purposes
        SET status = 'provisioning', message = 'view update', updated_at = $2
        WHERE session_id = $1 AND purpose = 'realtime'
        RETURNING id, status, message
      `, [sessionId, new Date(now.getTime() + 1)]);
      expect(returnedUpdate.rows).toEqual([{
        id: assignmentId,
        status: "provisioning",
        message: "view update",
      }]);
      const mirroredView = await client.query<{ status: string; message: string }>(`
        SELECT status, message FROM transcription_assignments WHERE session_id = $1
      `, [sessionId]);
      expect(mirroredView.rows).toEqual([{ status: "provisioning", message: "view update" }]);

      const returnedDelete = await client.query<{ id: string }>(`
        DELETE FROM transcription_assignment_purposes
        WHERE session_id = $1 AND purpose = 'realtime'
        RETURNING id
      `, [sessionId]);
      expect(returnedDelete.rows).toEqual([{ id: assignmentId }]);
      const remaining = await client.query<{ legacy: number; records: number }>(`
        SELECT
          (SELECT count(*)::int FROM transcription_assignments WHERE session_id = $1) AS legacy,
          (SELECT count(*)::int FROM transcription_assignment_records WHERE session_id = $1) AS records
      `, [sessionId]);
      expect(remaining.rows).toEqual([{ legacy: 0, records: 0 }]);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      client.release();
    }
  });

  it("keeps legacy ON CONFLICT(session_id) valid while purpose assignments coexist", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(now, "hybrid");
    const legacyId = randomUUID();
    await pool.query(`
      INSERT INTO transcription_assignments (
        id, session_id, worker_id, model_id, purpose, status, message,
        lease_expires_at, activated_at, released_at, created_at, updated_at
      ) VALUES ($1, $2, null, 'model-a', 'realtime', 'requested', null, $3, null, null, $4, $4)
      ON CONFLICT (session_id) DO NOTHING
    `, [legacyId, sessionId, new Date(now.getTime() + 900_000), now]);

    const mirrored = await workers.getAssignmentBySession(sessionId, "realtime");
    expect(mirrored).toMatchObject({
      id: legacyId,
      purpose: "realtime",
      status: "requested",
    });

    const batch = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-final",
      purpose: "batch",
      now: new Date(now.getTime() + 1),
      leaseSeconds: 900,
    });
    expect(batch.purpose).toBe("batch");
    expect(await workers.listAssignmentsBySession(sessionId)).toEqual([
      expect.objectContaining({ id: legacyId, purpose: "realtime" }),
      expect.objectContaining({ id: batch.id, purpose: "batch" }),
    ]);

    const legacyRows = await pool.query<{ purpose: string }>(
      "SELECT purpose FROM transcription_assignments WHERE session_id = $1",
      [sessionId],
    );
    expect(legacyRows.rows).toEqual([{ purpose: "realtime" }]);
    await expect(pool.query(`
      INSERT INTO transcription_assignments (
        id, session_id, worker_id, model_id, purpose, status, message,
        lease_expires_at, activated_at, released_at, created_at, updated_at
      ) VALUES ($1, $2, null, 'model-a', 'realtime', 'requested', null, $3, null, null, $4, $4)
      ON CONFLICT (session_id) DO NOTHING
    `, [randomUUID(), sessionId, new Date(now.getTime() + 900_000), now])).resolves.toBeDefined();
  });

  it("serializes concurrent legacy and purpose-view updates in legacy-to-record order", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(now);
    const assignment = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now,
      leaseSeconds: 900,
    });
    const purposeStore = new PostgresWorkerPoolStore(databaseUrlFor("purpose-update-race"));
    let timeout: NodeJS.Timeout | undefined;
    try {
      const updates = Array.from({ length: 12 }, (_, index) => Promise.all([
        pool.query(`
          UPDATE transcription_assignments
          SET message = $2, updated_at = $3
          WHERE session_id = $1
        `, [sessionId, `legacy-${index}`, new Date(now.getTime() + index + 1)]),
        purposeStore.markProvisioning(
          assignment.id,
          null,
          `purpose-${index}`,
          new Date(now.getTime() + index + 1),
          900,
        ),
      ]));
      await Promise.race([
        Promise.all(updates),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("legacy/purpose update race timed out")),
            10_000,
          );
        }),
      ]);

      const legacy = await pool.query<{ status: string; message: string | null }>(
        "SELECT status, message FROM transcription_assignments WHERE session_id = $1",
        [sessionId],
      );
      const record = await pool.query<{ status: string; message: string | null }>(
        "SELECT status, message FROM transcription_assignment_records WHERE session_id = $1 AND purpose = 'realtime'",
        [sessionId],
      );
      expect(record.rows).toEqual(legacy.rows);
    } finally {
      if (timeout) clearTimeout(timeout);
      await purposeStore.close();
    }
  });

  it("keeps the first terminal transcription outcome under completion races", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(startedAt);
    const completed = await transcriptions.complete(sessionId, {
      status: "completed",
      durationMs: 1_200,
      metrics: { stable_latency_p95_ms: 900 },
      now: new Date(startedAt.getTime() + 1_200),
    });
    const lateFailure = await transcriptions.complete(sessionId, {
      status: "failed",
      durationMs: 9_999,
      metrics: { stable_latency_p95_ms: 9_999 },
      now: new Date(startedAt.getTime() + 2_000),
    });

    expect(completed).toMatchObject({ status: "completed", duration_ms: 1_200 });
    expect(lateFailure).toMatchObject({
      status: "completed",
      duration_ms: 1_200,
      metrics: { stable_latency_p95_ms: 900 },
    });
  });

  it("does not let an older utterance revision overwrite a newer final", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(startedAt);
    const base = {
      utteranceId: "utt-1",
      words: [],
      contextHits: [],
      audioStartMs: 400,
      audioEndMs: 1_000,
      latencyMs: 200,
      queueMs: 10,
      rtf: 0.2,
    };
    await transcriptions.upsertUtterance(sessionId, {
      ...base,
      revision: 4,
      text: "new final",
      now: new Date(startedAt.getTime() + 1_000),
    });
    const stale = await transcriptions.upsertUtterance(sessionId, {
      ...base,
      revision: 2,
      text: "stale retry",
      now: new Date(startedAt.getTime() + 2_000),
    });

    expect(stale).toMatchObject({ revision: 4, text: "new final", audio_start_ms: 400 });
    expect(await transcriptions.get(sessionId, new Date(startedAt.getTime() + 3_000)))
      .toMatchObject({ utterances: [{ revision: 4, text: "new final" }] });
  });

  it("allows a saved transcription to be renamed after completion", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(startedAt);
    await transcriptions.complete(sessionId, {
      status: "completed",
      durationMs: 1_200,
      metrics: {},
      now: new Date(startedAt.getTime() + 1_200),
    });

    const renamed = await transcriptions.rename(
      sessionId,
      "保存済みの証券通話",
      new Date(startedAt.getTime() + 2_000),
    );

    expect(renamed).toMatchObject({
      status: "completed",
      title: "保存済みの証券通話",
      title_customized: true,
    });
  });

  it("never exceeds capacity under 32 concurrent reservations", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    await workers.seedKnownWorkers([{
      id: "worker-a",
      podId: "pod-a",
      name: "A100 worker",
      serviceUrl: "https://pod-a-8000.proxy.runpod.net",
      modelId: "model-a",
      runtime: "realtime",
      maxSessions: 8,
      enabled: true,
    }], now);
    await workers.updateWorker("worker-a", { status: "ready" }, now);

    const sessionIds = await Promise.all(Array.from({ length: 32 }, () => createSession(now)));
    const assignments = await Promise.all(sessionIds.map((sessionId) => workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now,
      leaseSeconds: 900,
    })));
    const reserved = await Promise.all(assignments.map((assignment) => (
      workers.reserveReadyWorker(assignment.id, now, 900)
    )));

    expect(reserved.filter((assignment) => assignment.status === "ready")).toHaveLength(8);
    expect((await workers.getWorker("worker-a"))?.activeSessions).toBe(8);
  });

  it("persists a hybrid session and isolates its two purpose assignments", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = randomUUID();
    await transcriptions.create({
      id: sessionId,
      source: "microphone",
      processingMode: "hybrid",
      modelId: "model-realtime",
      finalModelId: "model-final",
      catalogRevision: "catalog-test",
      now,
      retentionDays: 30,
    });
    expect(await transcriptions.get(sessionId, now)).toMatchObject({
      processing_mode: "hybrid",
      model_id: "model-realtime",
      final_model_id: "model-final",
    });

    await workers.seedKnownWorkers([
      {
        id: "worker-realtime",
        podId: "pod-realtime",
        name: "Realtime worker",
        serviceUrl: "https://pod-realtime-8000.proxy.runpod.net",
        modelId: "model-realtime",
        runtime: "realtime",
        maxSessions: 1,
        enabled: true,
      },
      {
        id: "worker-final",
        podId: "pod-final",
        name: "Finalizer worker",
        serviceUrl: "https://pod-final-8000.proxy.runpod.net",
        modelId: "model-final",
        runtime: "batch",
        maxSessions: 1,
        enabled: true,
      },
    ], now);
    await workers.updateWorker("worker-realtime", { status: "ready" }, now);
    await workers.updateWorker("worker-final", { status: "ready" }, now);

    const batch = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-final",
      purpose: "batch",
      now,
      leaseSeconds: 900,
    });
    const realtime = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-realtime",
      purpose: "realtime",
      now,
      leaseSeconds: 900,
    });
    const retry = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-realtime",
      purpose: "realtime",
      now: new Date(now.getTime() + 1),
      leaseSeconds: 900,
    });
    expect(retry.id).toBe(realtime.id);
    expect(batch.id).not.toBe(realtime.id);
    const legacy = await pool.query<{ id: string; purpose: string }>(
      "SELECT id, purpose FROM transcription_assignments WHERE session_id = $1",
      [sessionId],
    );
    expect(legacy.rows).toEqual([{ id: realtime.id, purpose: "realtime" }]);
    const records = await pool.query<{ id: string; purpose: string }>(
      "SELECT id, purpose FROM transcription_assignment_records WHERE session_id = $1 ORDER BY purpose",
      [sessionId],
    );
    expect(records.rows).toEqual([
      { id: batch.id, purpose: "batch" },
      { id: realtime.id, purpose: "realtime" },
    ]);
    await workers.reserveReadyWorker(realtime.id, now, 900);
    await workers.reserveReadyWorker(batch.id, now, 900);
    expect(await workers.touch(sessionId, new Date(now.getTime() + 2), 900)).toEqual([
      expect.objectContaining({ purpose: "realtime", status: "active" }),
      expect.objectContaining({ purpose: "batch", status: "active" }),
    ]);

    await workers.releaseAssignment(realtime.id, new Date(now.getTime() + 3));
    expect(await workers.getAssignmentBySession(sessionId, "realtime")).toMatchObject({ status: "released" });
    expect(await workers.getAssignmentBySession(sessionId, "batch")).toMatchObject({ status: "active" });
    expect(await workers.getWorker("worker-realtime")).toMatchObject({ activeSessions: 0 });
    expect(await workers.getWorker("worker-final")).toMatchObject({ activeSessions: 1 });

    await workers.release(sessionId, new Date(now.getTime() + 4));
    expect(await workers.getAssignmentBySession(sessionId, "batch")).toMatchObject({ status: "released" });
    expect(await workers.getWorker("worker-final")).toMatchObject({ activeSessions: 0 });
  });

  it("locks shared workers in one order across concurrent release and reaping", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const releaseSessionId = randomUUID();
    const reapSessionId = randomUUID();
    for (const id of [releaseSessionId, reapSessionId]) {
      await transcriptions.create({
        id,
        source: "microphone",
        processingMode: "hybrid",
        modelId: "model-realtime",
        finalModelId: "model-final",
        catalogRevision: "catalog-test",
        now,
        retentionDays: 30,
      });
    }
    await workers.seedKnownWorkers([
      {
        id: "counter-a",
        podId: "pod-counter-a",
        name: "Counter A",
        serviceUrl: "https://counter-a-8000.proxy.runpod.net",
        modelId: "model-realtime",
        runtime: "realtime",
        maxSessions: 4,
        enabled: true,
      },
      {
        id: "counter-z",
        podId: "pod-counter-z",
        name: "Counter Z",
        serviceUrl: "https://counter-z-8000.proxy.runpod.net",
        modelId: "model-final",
        runtime: "batch",
        maxSessions: 4,
        enabled: true,
      },
    ], now);
    await workers.updateWorker("counter-a", { status: "ready", activeSessions: 2 }, now);
    await workers.updateWorker("counter-z", { status: "ready", activeSessions: 2 }, now);

    const releaseBatchId = "00000000-0000-4000-8000-000000000101";
    const releaseRealtimeId = "ffffffff-ffff-4fff-bfff-fffffffff101";
    const reapRealtimeId = "00000000-0000-4000-8000-000000000102";
    const reapBatchId = "ffffffff-ffff-4fff-bfff-fffffffff102";
    await pool.query(`
      INSERT INTO transcription_assignment_purposes (
        id, session_id, worker_id, model_id, purpose, status, message,
        lease_expires_at, activated_at, released_at, created_at, updated_at
      ) VALUES
        ($1, $5, 'counter-z', 'model-final', 'batch', 'active', null, $7, $6, null, $6, $6),
        ($2, $5, 'counter-a', 'model-realtime', 'realtime', 'active', null, $7, $6, null, $6, $6),
        ($3, $8, 'counter-a', 'model-realtime', 'realtime', 'active', null, $9, $6, null, $6, $6),
        ($4, $8, 'counter-z', 'model-final', 'batch', 'active', null, $9, $6, null, $6, $6)
    `, [
      releaseBatchId,
      releaseRealtimeId,
      reapRealtimeId,
      reapBatchId,
      releaseSessionId,
      now,
      new Date(now.getTime() + 60_000),
      reapSessionId,
      new Date(now.getTime() - 1),
    ]);

    const releaseStore = new PostgresWorkerPoolStore(databaseUrlFor("worker-counter-release"));
    const reaperStore = new PostgresWorkerPoolStore(databaseUrlFor("worker-counter-reaper"));
    const locker = await pool.connect();
    let releasePromise: ReturnType<typeof releaseStore.release> | null = null;
    let reaperPromise: ReturnType<typeof reaperStore.reapExpired> | null = null;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query(`
        SELECT id FROM inference_workers
        WHERE id IN ('counter-a', 'counter-z')
        ORDER BY id
        FOR UPDATE
      `);
      releasePromise = releaseStore.release(releaseSessionId, new Date(now.getTime() + 1));
      reaperPromise = reaperStore.reapExpired(now);
      await Promise.all([
        waitForLock("worker-counter-release"),
        waitForLock("worker-counter-reaper"),
      ]);
      await locker.query("COMMIT");

      const [released, reaped] = await Promise.race([
        Promise.all([releasePromise, reaperPromise]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("release/reaper worker lock order timed out")),
            10_000,
          );
        }),
      ]);
      expect(released).toHaveLength(2);
      expect(reaped).toBe(2);
      expect(await workers.getWorker("counter-a")).toMatchObject({ activeSessions: 0 });
      expect(await workers.getWorker("counter-z")).toMatchObject({ activeSessions: 0 });
      expect(await workers.listAssignmentsBySession(releaseSessionId)).toEqual([
        expect.objectContaining({ status: "released" }),
        expect.objectContaining({ status: "released" }),
      ]);
      expect(await workers.listAssignmentsBySession(reapSessionId)).toEqual([
        expect.objectContaining({ status: "released" }),
        expect.objectContaining({ status: "released" }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      await Promise.allSettled([releasePromise, reaperPromise].filter(Boolean));
      await Promise.all([releaseStore.close(), reaperStore.close()]);
    }
  });

  it("atomically requeues worker-loss assignments and restores capacity", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const sessionId = await createSession(now);
    await workers.seedKnownWorkers([{
      id: "worker-lost",
      podId: "pod-lost",
      name: "Lost worker",
      serviceUrl: "https://pod-lost-8000.proxy.runpod.net",
      modelId: "model-a",
      runtime: "realtime",
      maxSessions: 1,
      enabled: true,
    }], now);
    await workers.updateWorker("worker-lost", { status: "ready" }, now);
    const assignment = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now,
      leaseSeconds: 900,
    });
    await workers.reserveReadyWorker(assignment.id, now, 900);
    await workers.touch(sessionId, new Date(now.getTime() + 1), 900, "realtime");

    const requeued = await workers.requeueAssignmentsForWorker(
      "worker-lost",
      new Date(now.getTime() + 2),
      900,
      "worker lost",
    );

    expect(requeued).toEqual([
      expect.objectContaining({ id: assignment.id, workerId: null, status: "requested" }),
    ]);
    expect(await workers.getWorker("worker-lost")).toMatchObject({ activeSessions: 0 });
    expect(await workers.countActiveSessions(["ready", "active"])).toBe(0);
  });

  it("single-flights concurrent stopped starts and cold provisioning claims", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    await workers.seedKnownWorkers([{
      id: "worker-stopped",
      podId: "pod-stopped",
      name: "Stopped worker",
      serviceUrl: "https://pod-stopped-8000.proxy.runpod.net",
      modelId: "model-static",
      runtime: "realtime",
      maxSessions: 32,
      enabled: true,
    }], now);

    const startClaims = await Promise.all(Array.from({ length: 32 }, () => (
      workers.claimStoppedWorkerForStart("worker-stopped", now)
    )));
    expect(startClaims.filter(Boolean)).toHaveLength(1);
    expect(await workers.getWorker("worker-stopped")).toMatchObject({ status: "starting" });

    const provisioningClaims = await Promise.all(Array.from({ length: 32 }, (_, index) => (
      workers.claimProvisioningWorker({
        id: `cold-worker-${index}`,
        podId: "",
        name: `Cold worker ${index}`,
        serviceUrl: "https://provisioning.invalid",
        modelId: "model-cold",
        runtime: "realtime",
        maxSessions: 32,
        enabled: true,
      }, 4, now)
    )));
    expect(provisioningClaims.filter((claim) => claim?.acquired)).toHaveLength(1);
    expect(new Set(provisioningClaims.map((claim) => claim?.worker.id)).size).toBe(1);
    expect((await workers.listWorkers()).filter((worker) => worker.modelId === "model-cold")).toHaveLength(1);
  });

  it("does not reap an expired assignment while a queued touch renews its lease", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const raceAt = new Date(startedAt.getTime() + 2_000);
    await workers.seedKnownWorkers([{
      id: "worker-touch",
      podId: "pod-touch",
      name: "Touch race worker",
      serviceUrl: "https://pod-touch-8000.proxy.runpod.net",
      modelId: "model-a",
      runtime: "realtime",
      maxSessions: 1,
      enabled: true,
    }], startedAt);
    await workers.updateWorker("worker-touch", { status: "ready" }, startedAt);
    const sessionId = await createSession(startedAt);
    const assignment = await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now: startedAt,
      leaseSeconds: 1,
    });
    await workers.reserveReadyWorker(assignment.id, startedAt, 1);

    const touchStore = new PostgresWorkerPoolStore(databaseUrlFor("worker-touch-race"));
    const locker = await pool.connect();
    let touchPromise: ReturnType<typeof touchStore.touch> | null = null;
    let reapedPromise: ReturnType<typeof workers.reapExpired> | null = null;
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT id FROM transcription_assignment_purposes WHERE session_id = $1 FOR UPDATE",
        [sessionId],
      );
      touchPromise = touchStore.touch(sessionId, raceAt, 900);
      await waitForLock("worker-touch-race");
      reapedPromise = workers.reapExpired(raceAt);
      await locker.query("COMMIT");
      const touched = await touchPromise;
      const reaped = await reapedPromise;

      expect(reaped).toBe(0);
      expect(touched).toEqual([expect.objectContaining({ status: "active" })]);
      expect(await workers.getAssignmentBySession(sessionId)).toMatchObject({ status: "active" });
      expect(await workers.getWorker("worker-touch")).toMatchObject({ activeSessions: 1 });
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      await Promise.allSettled([touchPromise, reapedPromise].filter(Boolean));
      await touchStore.close();
    }
  });

  it("rejects existing and new purpose assignments after terminalization wins the session lock", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const requestAt = new Date(startedAt.getTime() + 1_000);
    const sessionId = await createSession(startedAt, "hybrid");
    await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now: startedAt,
      leaseSeconds: 900,
    });
    const existingStore = new PostgresWorkerPoolStore(databaseUrlFor("assignment-after-terminal-existing"));
    const newPurposeStore = new PostgresWorkerPoolStore(databaseUrlFor("assignment-after-terminal-new"));
    const locker = await pool.connect();
    let existingPending: ReturnType<typeof existingStore.createRequestedAssignment> | null = null;
    let newPurposePending: ReturnType<typeof newPurposeStore.createRequestedAssignment> | null = null;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM transcription_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      existingPending = existingStore.createRequestedAssignment({
        sessionId,
        modelId: "model-a",
        purpose: "realtime",
        now: requestAt,
        leaseSeconds: 900,
      });
      newPurposePending = newPurposeStore.createRequestedAssignment({
        sessionId,
        modelId: "model-final",
        purpose: "batch",
        now: requestAt,
        leaseSeconds: 900,
      });
      const existingResult = existingPending.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      const newPurposeResult = newPurposePending.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await Promise.all([
        waitForLock("assignment-after-terminal-existing"),
        waitForLock("assignment-after-terminal-new"),
      ]);
      await locker.query(
        "UPDATE transcription_sessions SET status = 'completed', ended_at = $2, updated_at = $2 WHERE id = $1",
        [sessionId, requestAt],
      );
      await locker.query("COMMIT");

      expect((await existingResult).error).toMatchObject({
        code: "transcription_not_active",
        status: 409,
      });
      expect((await newPurposeResult).error).toMatchObject({
        code: "transcription_not_active",
        status: 409,
      });
      expect(await workers.getAssignmentBySession(sessionId, "batch")).toBeNull();
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      await Promise.allSettled([existingPending, newPurposePending].filter(Boolean));
      await Promise.all([existingStore.close(), newPurposeStore.close()]);
    }
  });

  it("rejects assignment creation after the transcription retention deadline", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const requestAt = new Date(startedAt.getTime() + 10_000);
    const sessionId = await createSession(startedAt);
    await pool.query(
      "UPDATE transcription_sessions SET expires_at = $2 WHERE id = $1",
      [sessionId, new Date(requestAt.getTime() - 1)],
    );

    await expect(workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now: requestAt,
      leaseSeconds: 900,
    })).rejects.toMatchObject({ code: "transcription_not_found", status: 404 });
    expect(await workers.listAssignmentsBySession(sessionId)).toEqual([]);
  });

  it("terminalizes stale hybrid sessions before releasing and rejects a late finalizer assignment", async () => {
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const maintenanceAt = new Date(startedAt.getTime() + 11 * 60_000);
    const sessionId = await createSession(startedAt, "hybrid");
    await workers.createRequestedAssignment({
      sessionId,
      modelId: "model-a",
      purpose: "realtime",
      now: startedAt,
      leaseSeconds: 900,
    });
    let lateError: unknown = null;

    const result = await runRetentionMaintenance(
      transcriptions,
      { transcriptStaleMinutes: 10 } as AppConfig,
      maintenanceAt,
      async (candidateId) => {
        await workers.release(candidateId, maintenanceAt);
        try {
          await workers.createRequestedAssignment({
            sessionId: candidateId,
            modelId: "model-final",
            purpose: "batch",
            now: maintenanceAt,
            leaseSeconds: 900,
          });
        } catch (error) {
          lateError = error;
        }
      },
    );

    expect(result).toEqual({ expired: 0, stale: 1 });
    expect(lateError).toMatchObject({ code: "transcription_not_active", status: 409 });
    expect(await workers.getAssignmentBySession(sessionId, "realtime")).toMatchObject({ status: "released" });
    expect(await workers.getAssignmentBySession(sessionId, "batch")).toBeNull();
    expect(await transcriptions.get(sessionId, maintenanceAt)).toMatchObject({ status: "interrupted" });
  });

  it("enforces unique non-empty Pod IDs at the database boundary", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    await workers.seedKnownWorkers([{
      id: "worker-pod-a",
      podId: "shared-pod-id",
      name: "First worker",
      serviceUrl: "https://worker-pod-a-8000.proxy.runpod.net",
      modelId: "model-a",
      runtime: "realtime",
      maxSessions: 1,
      enabled: true,
    }], now);

    await expect(workers.upsertWorker({
      id: "worker-pod-b",
      podId: "shared-pod-id",
      name: "Duplicate worker",
      serviceUrl: "https://worker-pod-b-8000.proxy.runpod.net",
      modelId: "model-b",
      runtime: "realtime",
      maxSessions: 1,
      enabled: true,
    }, "ready", now)).rejects.toMatchObject({ code: "database_unavailable" });
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM inference_workers WHERE pod_id = $1",
      ["shared-pod-id"],
    );
    expect(result.rows[0]?.count).toBe(1);
  });
});
