import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { MockRunPodProvider, ReadonlyRunPodProvider } from "../../server/runpod.js";

describe("control API", () => {
  let clock: number;
  let provider: MockRunPodProvider;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = 10_000;
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
      MOCK_INITIAL_STATUS: "EXITED",
      MOCK_READY_DELAY_MS: "1000",
    });
    provider = new MockRunPodProvider(config, () => clock);
    app = createApp(config, provider, { serveStatic: false, now: () => clock });
  });

  it("returns the standard authentication error envelope", async () => {
    const response = await request(app).get("/api/control/status").expect(401);
    expect(response.body.error.code).toBe("authentication_required");
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("rejects an invalid password", async () => {
    const response = await request(app).post("/api/session/login").set("origin", "http://localhost").send({ password: "wrong-password" }).expect(401);
    expect(response.body.error.code).toBe("invalid_credentials");
  });

  it("runs the stopped to starting to ready to stopped lifecycle idempotently", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    expect((await agent.get("/api/control/status").expect(200)).body.data.stage).toBe("stopped");

    await agent.post("/api/control/start").set("origin", "http://localhost").send({}).expect(202);
    await agent.post("/api/control/start").set("origin", "http://localhost").send({}).expect(202);
    expect(provider.startCalls).toBe(1);
    expect((await agent.get("/api/control/status").expect(200)).body.data.stage).toBe("starting");

    clock += 1200;
    const ready = await agent.get("/api/control/status").expect(200);
    expect(ready.body.data.stage).toBe("ready");
    expect(ready.body.data.service.health.catalog_terms).toBe(248);
    expect(ready.body.data.pod.gpu.displayName).toBe("NVIDIA A100 80GB");
    expect(ready.body.data.service.health.gpu_memory_total_mb).toBe(81_920);
    expect(JSON.stringify(ready.body)).not.toContain("RUNPOD_API_KEY");

    await agent.post("/api/control/stop").set("origin", "http://localhost").send({}).expect(202);
    expect(provider.stopCalls).toBe(1);
    expect((await agent.get("/api/control/status").expect(200)).body.data.stage).toBe("stopped");
  });

  it("blocks a mutation from another origin", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    const response = await agent.post("/api/control/start").set("origin", "https://attacker.example").send({}).expect(403);
    expect(response.body.error.code).toBe("origin_not_allowed");
  });

  it("probes the live ASR service but blocks GPU mutations in read-only mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "readonly",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
    });
    const fetcher = async () => new Response(JSON.stringify({ model: "context-fullft", catalog_terms: 248 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const readonlyApp = createApp(config, new ReadonlyRunPodProvider(config, fetcher), { serveStatic: false });
    const agent = request.agent(readonlyApp);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const status = await agent.get("/api/control/status").expect(200);
    expect(status.body.data.stage).toBe("ready");
    expect(status.body.data.control).toEqual({ mode: "readonly", available: false });
    expect(status.body.data.pod.gpu).toEqual({ id: "A100-80GB", displayName: "NVIDIA A100 80GB", count: 1 });
    expect(status.body.data.service.health.catalog_terms).toBe(248);
    expect(status.body.data.service.batchUrl).toBe("https://nhf73n5jvajgyj-8000.proxy.runpod.net/v1/transcribe");

    const start = await agent.post("/api/control/start").set("origin", "http://localhost").send({}).expect(503);
    expect(start.body.error.code).toBe("runpod_control_unavailable");
  });

  it("returns the curated transcription model catalog", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const response = await agent.get("/api/models").expect(200);
    expect(response.body.data.default_model_id).toBe("infodeliverailab/qwen3-asr-ja-rlbr-context-fullft");
    expect(response.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
        runtime: "realtime",
        input_modes: ["microphone", "file"],
      }),
      expect.objectContaining({
        id: "infodeliverailab/qwen3-omni-jp-vllm",
        runtime: "batch",
        input_modes: ["file"],
      }),
    ]));
  });

  it("rejects model ids outside the curated ASR catalog", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const response = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      model_id: "infodeliverailab/diarization_model_0714_ytv2",
    }).expect(400);
    expect(response.body.error.code).toBe("validation_failed");
  });

  it("persists, searches, renames, completes, and deletes transcription history", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      catalog_revision: "catalog-1",
    }).expect(201);
    const id = created.body.data.id as string;
    expect(created.body.data.status).toBe("recording");
    expect(created.body.data.expires_at).toBe(new Date(clock + 30 * 86_400_000).toISOString());

    const finalPayload = {
      revision: 3,
      text: "あかつき証券の佐藤です。",
      words: [
        { text: "あかつき証券", start_ms: 0, end_ms: 720, speaker: "speaker_1", confidence: 0.98 },
        { text: "の佐藤です", start_ms: 720, end_ms: 1300, speaker: "speaker_1", confidence: 0.97 },
      ],
      context_hits: ["あかつき証券"],
      audio_end_ms: 1300,
      latency_ms: 820,
      queue_ms: 120,
      rtf: 0.31,
    };
    await agent.put(`/api/transcriptions/${id}/utterances/utt-1`).set("origin", "http://localhost").send(finalPayload).expect(200);
    await agent.put(`/api/transcriptions/${id}/utterances/utt-1`).set("origin", "http://localhost").send({
      ...finalPayload,
      revision: 4,
      text: "あかつき証券の佐藤でございます。",
    }).expect(200);

    const detail = await agent.get(`/api/transcriptions/${id}`).expect(200);
    expect(detail.body.data.title).toBe("あかつき証券の佐藤です。");
    expect(detail.body.data.utterance_count).toBe(1);
    expect(detail.body.data.utterances).toHaveLength(1);
    expect(detail.body.data.utterances[0].revision).toBe(4);

    const search = await agent.get("/api/transcriptions").query({ q: "あかつき", limit: 10 }).expect(200);
    expect(search.body.data).toHaveLength(1);
    expect(search.body.meta.totalCount).toBe(1);

    await agent.patch(`/api/transcriptions/${id}`).set("origin", "http://localhost").send({ title: "証券通話テスト" }).expect(200);
    await agent.post(`/api/transcriptions/${id}/complete`).set("origin", "http://localhost").send({
      status: "completed",
      duration_ms: 1300,
      metrics: { stable_latency_p95_ms: 1180, context_hits: 1 },
    }).expect(200);

    const completed = await agent.get(`/api/transcriptions/${id}`).expect(200);
    expect(completed.body.data.title).toBe("証券通話テスト");
    expect(completed.body.data.title_customized).toBe(true);
    expect(completed.body.data.status).toBe("completed");
    expect(completed.body.data.metrics.stable_latency_p95_ms).toBe(1180);

    await agent.delete(`/api/transcriptions/${id}`).set("origin", "http://localhost").expect(200);
    await agent.get(`/api/transcriptions/${id}`).expect(404);
  });

  it("expires transcription history after the retention period", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    const created = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      catalog_revision: "",
    }).expect(201);
    clock += 30 * 86_400_000 + 1;
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    await agent.get(`/api/transcriptions/${created.body.data.id}`).expect(404);
    const history = await agent.get("/api/transcriptions").expect(200);
    expect(history.body.data).toEqual([]);
  });

  it("protects transcription mutations with the origin policy", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);
    const response = await agent.post("/api/transcriptions").set("origin", "https://attacker.example").send({
      source: "microphone",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
    }).expect(403);
    expect(response.body.error.code).toBe("origin_not_allowed");
  });
});
