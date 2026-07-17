import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { MockRunPodProvider, ReadonlyRunPodProvider } from "../../server/runpod.js";
import type { PodInfo, WorkerRecord } from "../../server/types.js";
import type { CreateRunPodInput, RunPodFleetClient, WorkerAdminClient, WorkerProbe } from "../../server/worker-clients.js";
import { WorkerScheduler } from "../../server/worker-scheduler.js";
import { MemoryWorkerPoolStore } from "../../server/worker-store.js";

const modelId = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";
const finalModelId = "infodeliverailab/lab_asr_diarization_v1";

class ReadyFleet implements RunPodFleetClient {
  canMutate = true;
  canCreate(modelId: string, runtime: "realtime" | "batch") {
    void modelId;
    void runtime;
    return false;
  }
  async getPod(podId: string): Promise<PodInfo> { return { id: podId, desiredStatus: "RUNNING" }; }
  async findPodByWorkerId(workerId: string): Promise<PodInfo | null> {
    void workerId;
    return null;
  }
  async startPod(podId: string) { void podId; }
  async stopPod(podId: string) { void podId; }
  async createPod(input: CreateRunPodInput): Promise<PodInfo> {
    void input;
    throw new Error("not supported");
  }
}

class BatchProvisioningFleet extends ReadyFleet {
  findCalls: string[] = [];
  createCalls: CreateRunPodInput[] = [];

  override canCreate(candidateModelId: string, runtime: "realtime" | "batch") {
    return candidateModelId === finalModelId && runtime === "batch";
  }

  override async findPodByWorkerId(workerId: string): Promise<PodInfo | null> {
    this.findCalls.push(workerId);
    return null;
  }

  override async createPod(input: CreateRunPodInput): Promise<PodInfo> {
    this.createCalls.push(input);
    return { id: "pod-batch-created", desiredStatus: "RUNNING" };
  }
}

class ReadyAdmin implements WorkerAdminClient {
  async probe(worker: WorkerRecord): Promise<WorkerProbe> {
    return {
      ready: true,
      workerId: worker.id,
      modelId: worker.modelId,
      health: {
        worker_id: worker.id,
        model_id: worker.modelId,
        accelerator: "NVIDIA A100 80GB",
        catalog_revision: worker.runtime === "realtime" ? "realtime-catalog" : "batch-must-not-apply",
      },
    };
  }
  async drain(worker: WorkerRecord) { void worker; }
}

describe("worker pool API", () => {
  let clock: number;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = 10_000;
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
      MOCK_INITIAL_STATUS: "EXITED",
      MOCK_READY_DELAY_MS: "1000",
      RUNPOD_POOL_MAX_WORKERS: "1",
      RUNPOD_POD_ID: "test-pod-a",
      RUNPOD_SERVICE_URL: "https://test-pod-a-8000.proxy.runpod.net",
      RUNPOD_WORKERS_JSON: JSON.stringify([{
        id: "worker-a",
        pod_id: "test-pod-a",
        name: "A100 worker",
        service_url: "https://test-pod-a-8000.proxy.runpod.net",
        model_id: modelId,
        runtime: "realtime",
        max_sessions: 32,
        enabled: true,
      }]),
    });
    app = createApp(config, new MockRunPodProvider(config, () => clock), { serveStatic: false, now: () => clock });
  });

  async function loginAndCreate() {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      model_id: modelId,
      catalog_revision: "catalog-1",
    }).expect(201);
    return { agent, id: created.body.data.id as string };
  }

  it("requires authentication and protects assignment mutations by Origin", async () => {
    await request(app).get("/api/workers").expect(401);
    const { agent, id } = await loginAndCreate();
    const response = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "https://attacker.example")
      .send({ purpose: "realtime" })
      .expect(403);
    expect(response.body.error.code).toBe("origin_not_allowed");
  });

  it("moves from 202 provisioning to ready and returns the same assignment on retry", async () => {
    const { agent, id } = await loginAndCreate();
    const pending = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost")
      .send({ purpose: "realtime" })
      .expect(202);
    expect(pending.body.data).toMatchObject({ session_id: id, model_id: modelId, purpose: "realtime", status: "provisioning" });
    expect(pending.body.data.connection).toBeUndefined();

    clock += 1200;
    const ready = await agent.post(`/api/transcriptions/${id}/assignment`).set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);
    expect(ready.body.data.status).toBe("ready");
    expect(ready.body.data.worker).toMatchObject({ id: "worker-a", loaded_model_id: modelId, gpu_type: "NVIDIA A100 80GB" });
    expect(ready.body.data.connection.websocket_url).toBe("wss://test-pod-a-8000.proxy.runpod.net/v1/realtime");
    expect(ready.body.data.connection.ticket).toBeTypeOf("string");

    const retry = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost")
      .send({ purpose: "realtime" })
      .expect(200);
    expect(retry.body.data.id).toBe(ready.body.data.id);
    expect(JSON.stringify(retry.body)).not.toContain("worker-ticket-secret-at-least-32-characters");
    expect(JSON.stringify(retry.body)).not.toContain("RUNPOD_API_KEY");

    const workers = await agent.get("/api/workers").expect(200);
    expect(workers.body.data).toMatchObject({
      total_workers: 1,
      ready_workers: 1,
      active_sessions: 1,
      capacity: 32,
      provisioning_assignments: 0,
    });
  });

  it("releases the assignment when the transcription completes", async () => {
    const { agent, id } = await loginAndCreate();
    await agent.post(`/api/transcriptions/${id}/assignment`).set("origin", "http://localhost").send({ purpose: "realtime" }).expect(202);
    clock += 1200;
    await agent.post(`/api/transcriptions/${id}/assignment`).set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);
    await agent.post(`/api/transcriptions/${id}/complete`).set("origin", "http://localhost").send({
      status: "completed",
      duration_ms: 1200,
      metrics: {},
    }).expect(200);
    const released = await agent.get(`/api/transcriptions/${id}/assignment`).expect(200);
    expect(released.body.data.status).toBe("released");
    expect((await agent.get("/api/workers").expect(200)).body.data.active_sessions).toBe(0);
  });

  it("authenticates assignment heartbeats and never renews after terminalization", async () => {
    const { agent, id } = await loginAndCreate();
    await request(app).post(`/api/transcriptions/${id}/assignment/heartbeat`).send({}).expect(401);
    await agent.post(`/api/transcriptions/${id}/assignment/heartbeat`)
      .set("origin", "https://attacker.example")
      .send({})
      .expect(403);
    await agent.post(`/api/transcriptions/${id}/assignment`).set("origin", "http://localhost").send({ purpose: "realtime" }).expect(202);
    clock += 1_200;
    await agent.post(`/api/transcriptions/${id}/assignment`).set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);

    clock += 14 * 60 * 1_000;
    const heartbeat = await agent.post(`/api/transcriptions/${id}/assignment/heartbeat`)
      .set("origin", "http://localhost")
      .send({})
      .expect(200);
    expect(heartbeat.body.data).toEqual({
      status: "active",
      lease_expires_at: new Date(clock + 900_000).toISOString(),
      assignments: [{
        purpose: "realtime",
        status: "active",
        lease_expires_at: new Date(clock + 900_000).toISOString(),
      }],
    });

    await agent.post(`/api/transcriptions/${id}/complete`).set("origin", "http://localhost").send({
      status: "completed",
      duration_ms: 14 * 60 * 1_000,
      metrics: {},
    }).expect(200);
    const late = await agent.post(`/api/transcriptions/${id}/assignment/heartbeat`)
      .set("origin", "http://localhost")
      .send({})
      .expect(409);
    expect(late.body.error.code).toBe("transcription_not_active");
    expect((await agent.get(`/api/transcriptions/${id}/assignment`).expect(200)).body.data.status).toBe("released");
  });

  it("allocates both hybrid purposes idempotently, returns purpose-specific URLs, and releases both", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
      RUNPOD_POOL_MAX_WORKERS: "2",
      RUNPOD_WORKERS_JSON: JSON.stringify([
        {
          id: "hybrid-realtime",
          pod_id: "pod-hybrid-realtime",
          name: "Hybrid realtime worker",
          service_url: "https://pod-hybrid-realtime-8000.proxy.runpod.net",
          model_id: modelId,
          runtime: "realtime",
          max_sessions: 1,
          enabled: true,
        },
        {
          id: "hybrid-batch",
          pod_id: "pod-hybrid-batch",
          name: "Hybrid finalizer worker",
          service_url: "https://pod-hybrid-batch-8000.proxy.runpod.net",
          model_id: finalModelId,
          runtime: "batch",
          max_sessions: 1,
          enabled: true,
        },
      ]),
    });
    const scheduler = new WorkerScheduler(
      config,
      new MemoryWorkerPoolStore(),
      new ReadyFleet(),
      new ReadyAdmin(),
      () => clock,
    );
    const hybridApp = createApp(config, new MockRunPodProvider(config, () => clock), {
      serveStatic: false,
      now: () => clock,
      scheduler,
    });
    const agent = request.agent(hybridApp);
    await agent.post("/api/session/login").set("origin", "http://localhost")
      .send({ password: "test-password" }).expect(200);
    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      processing_mode: "hybrid",
    }).expect(201);
    const id = created.body.data.id as string;

    const realtime = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);
    const batch = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost").send({ purpose: "batch" }).expect(200);
    expect(realtime.body.data).toMatchObject({
      session_id: id,
      model_id: modelId,
      purpose: "realtime",
      status: "ready",
      connection: {
        websocket_url: "wss://pod-hybrid-realtime-8000.proxy.runpod.net/v1/realtime",
        catalog_revision: "realtime-catalog",
      },
    });
    expect(realtime.body.data.connection.batch_url).toBeUndefined();
    expect(batch.body.data).toMatchObject({
      session_id: id,
      model_id: finalModelId,
      purpose: "batch",
      status: "ready",
      connection: {
        batch_url: "https://pod-hybrid-batch-8000.proxy.runpod.net/v1/audio/transcriptions",
        catalog_revision: null,
      },
    });
    expect(batch.body.data.connection.websocket_url).toBeUndefined();
    expect((await agent.get(`/api/transcriptions/${id}`).expect(200)).body.data.catalog_revision)
      .toBe("realtime-catalog");
    expect(batch.body.data.id).not.toBe(realtime.body.data.id);

    const realtimeRetry = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);
    const batchRetry = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost").send({ purpose: "batch" }).expect(200);
    expect(realtimeRetry.body.data.id).toBe(realtime.body.data.id);
    expect(batchRetry.body.data.id).toBe(batch.body.data.id);
    expect((await agent.get(`/api/transcriptions/${id}/assignment`).query({ purpose: "batch" }).expect(200)).body.data.id)
      .toBe(batch.body.data.id);

    const realtimeHeartbeat = await agent.post(`/api/transcriptions/${id}/assignment/heartbeat`)
      .set("origin", "http://localhost").send({ purpose: "realtime" }).expect(200);
    expect(realtimeHeartbeat.body.data.assignments).toEqual([
      expect.objectContaining({ purpose: "realtime", status: "active" }),
    ]);
    expect((await agent.get(`/api/transcriptions/${id}/assignment`)
      .query({ purpose: "batch" }).expect(200)).body.data.status).toBe("ready");

    const fallbackHeartbeat = await agent.post(`/api/transcriptions/${id}/assignment/heartbeat`)
      .set("origin", "http://localhost").send({}).expect(200);
    expect(fallbackHeartbeat.body.data.assignments).toEqual([
      expect.objectContaining({ purpose: "realtime", status: "active" }),
      expect.objectContaining({ purpose: "batch", status: "active" }),
    ]);
    expect((await agent.get("/api/workers").expect(200)).body.data).toMatchObject({
      active_sessions: 1,
      active_assignments: 2,
    });

    await agent.post(`/api/transcriptions/${id}/complete`).set("origin", "http://localhost").send({
      status: "completed",
      duration_ms: 1_200,
      metrics: {},
    }).expect(200);
    expect((await agent.get(`/api/transcriptions/${id}/assignment`).query({ purpose: "realtime" }).expect(200)).body.data.status)
      .toBe("released");
    expect((await agent.get(`/api/transcriptions/${id}/assignment`).query({ purpose: "batch" }).expect(200)).body.data.status)
      .toBe("released");
    expect((await agent.get("/api/workers").expect(200)).body.data.active_sessions).toBe(0);
  });

  it("returns a fail-loud API error before dynamically provisioning batch without a Network Volume", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
      RUNPOD_POOL_MAX_WORKERS: "1",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
        model_id: finalModelId,
        runtime: "batch",
        template_id: "template-batch",
        max_sessions: 1,
      }]),
    });
    const fleet = new BatchProvisioningFleet();
    const scheduler = new WorkerScheduler(
      config,
      new MemoryWorkerPoolStore(),
      fleet,
      new ReadyAdmin(),
      () => clock,
    );
    const dynamicApp = createApp(config, new MockRunPodProvider(config, () => clock), {
      serveStatic: false,
      now: () => clock,
      scheduler,
    });
    const agent = request.agent(dynamicApp);
    await agent.post("/api/session/login").set("origin", "http://localhost")
      .send({ password: "test-password" }).expect(200);
    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      processing_mode: "batch",
    }).expect(201);

    const blocked = await agent.post(`/api/transcriptions/${created.body.data.id}/assignment`)
      .set("origin", "http://localhost")
      .send({ purpose: "batch" })
      .expect(503);

    expect(blocked.body.error).toMatchObject({
      code: "runpod_network_volume_required",
      message: expect.stringContaining("RUNPOD_NETWORK_VOLUME_ID"),
    });
    expect(fleet.findCalls).toEqual([]);
    expect(fleet.createCalls).toEqual([]);
    expect((await agent.get("/api/workers").expect(200)).body.data.total_workers).toBe(0);
  });

  it("rejects an assignment purpose that the processing mode does not use", async () => {
    const { agent, id } = await loginAndCreate();
    const mismatch = await agent.post(`/api/transcriptions/${id}/assignment`)
      .set("origin", "http://localhost")
      .send({ purpose: "batch" })
      .expect(409);
    expect(mismatch.body.error.code).toBe("assignment_purpose_mismatch");
  });

  it("assigns an already-running legacy worker in read-only control mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "readonly",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
      RUNPOD_POD_ID: "test-readonly-pod",
      RUNPOD_SERVICE_URL: "https://test-readonly-pod-8000.proxy.runpod.net",
    });
    const fetcher = async () => new Response(JSON.stringify({
      ready: true,
      model_id: modelId,
      worker_id: "test-readonly-pod",
      accelerator: "NVIDIA A100 80GB",
    }), { status: 200, headers: { "content-type": "application/json" } });
    const readonlyApp = createApp(config, new ReadonlyRunPodProvider(config, fetcher), { serveStatic: false, now: () => clock });
    const agent = request.agent(readonlyApp);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({ source: "microphone", model_id: modelId }).expect(201);
    const assignment = await agent.post(`/api/transcriptions/${created.body.data.id}/assignment`)
      .set("origin", "http://localhost")
      .send({ purpose: "realtime" })
      .expect(200);
    expect(assignment.body.data.status).toBe("ready");
    expect(assignment.body.data.connection.websocket_url).toContain("test-readonly-pod-8000.proxy.runpod.net");
  });
});
