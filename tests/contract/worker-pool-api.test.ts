import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { MockRunPodProvider, ReadonlyRunPodProvider } from "../../server/runpod.js";

const modelId = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";

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
