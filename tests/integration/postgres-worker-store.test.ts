import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresTranscriptionStore } from "../../server/postgres-store.js";
import { PostgresWorkerPoolStore } from "../../server/worker-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the Postgres integration suite");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const transcriptions = new PostgresTranscriptionStore(databaseUrl);
const workers = new PostgresWorkerPoolStore(databaseUrl);

async function createSession(now: Date) {
  const id = randomUUID();
  await transcriptions.create({
    id,
    source: "microphone",
    modelId: "model-a",
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
      "TRUNCATE transcription_assignments, inference_workers, transcript_utterances, transcription_sessions CASCADE",
    );
  });

  afterAll(async () => {
    await Promise.all([workers.close(), transcriptions.close(), pool.end()]);
  });

  it("applies the worker migration and reports the store healthy", async () => {
    await expect(workers.health()).resolves.toEqual({ ready: true });
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

    expect(stale).toMatchObject({ revision: 4, text: "new final" });
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
        "SELECT id FROM transcription_assignments WHERE session_id = $1 FOR UPDATE",
        [sessionId],
      );
      touchPromise = touchStore.touch(sessionId, raceAt, 900);
      await waitForLock("worker-touch-race");
      reapedPromise = workers.reapExpired(raceAt);
      const outcome = await Promise.race([
        reapedPromise.then((value) => ({ completed: true as const, value })),
        new Promise<{ completed: false }>((resolve) => setTimeout(() => resolve({ completed: false }), 2_000)),
      ]);
      await locker.query("COMMIT");
      const touched = await touchPromise;
      const reaped = await reapedPromise;

      expect(outcome).toEqual({ completed: true, value: 0 });
      expect(reaped).toBe(0);
      expect(touched).toMatchObject({ status: "active" });
      expect(await workers.getAssignmentBySession(sessionId)).toMatchObject({ status: "active" });
      expect(await workers.getWorker("worker-touch")).toMatchObject({ activeSessions: 1 });
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      await Promise.allSettled([touchPromise, reapedPromise].filter(Boolean));
      await touchStore.close();
    }
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
