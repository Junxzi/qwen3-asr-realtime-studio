import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { MockRunPodProvider, ReadonlyRunPodProvider } from "../../server/runpod.js";
import { createWorkerScheduler } from "../../server/worker-scheduler.js";
import { MemoryWorkerPoolStore } from "../../server/worker-store.js";

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

  it("reports transcription storage and worker registry health", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body).toMatchObject({
      status: "healthy",
      storage: { kind: "memory", ready: true },
      worker_pool: { ready: true },
    });
  });

  it("degrades public health when the worker registry is unavailable", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
    });
    const unhealthyWorkerStore = new MemoryWorkerPoolStore();
    unhealthyWorkerStore.health = async () => ({ ready: false });
    const localProvider = new MockRunPodProvider(config, () => clock);
    const scheduler = createWorkerScheduler(config, localProvider, { store: unhealthyWorkerStore, now: () => clock });
    const unhealthyApp = createApp(config, localProvider, { serveStatic: false, scheduler });

    const response = await request(unhealthyApp).get("/api/health").expect(503);
    expect(response.body).toMatchObject({
      status: "degraded",
      storage: { ready: true },
      worker_pool: { ready: false },
    });
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

  it("never falls back to the legacy Pod for an explicitly configured worker pool", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      RUNPOD_WORKERS_JSON: "[]",
      CONTROL_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      ALLOWED_ORIGIN: "http://localhost",
    });
    const localProvider = new MockRunPodProvider(config, () => clock);
    const poolApp = createApp(config, localProvider, { serveStatic: false, now: () => clock });
    const agent = request.agent(poolApp);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const status = await agent.get("/api/control/status").expect(200);
    expect(status.body.data).toMatchObject({ stage: "stopped", pod: null });
    expect(status.body.data.pool.total_workers).toBe(0);
    const start = await agent.post("/api/control/start").set("origin", "http://localhost").send({}).expect(409);
    expect(start.body.error.code).toBe("worker_target_required");
    expect(localProvider.startCalls).toBe(0);
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
    expect(status.body.data.service.batchUrl).toBeUndefined();

    const start = await agent.post("/api/control/start").set("origin", "http://localhost").send({}).expect(503);
    expect(start.body.error.code).toBe("runpod_control_unavailable");
  });

  it("returns the curated transcription model catalog", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const response = await agent.get("/api/models").expect(200);
    expect(response.body.data.default_model_id).toBe("infodeliverailab/qwen3-asr-ja-rlbr-context-fullft");
    expect(response.body.data.items).toHaveLength(5);
    expect(response.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
        runtime: "realtime",
        input_modes: ["microphone", "file"],
        selectable: true,
      }),
      expect.objectContaining({
        id: "infodeliverailab/qwen3-omni-jp-vllm",
        runtime: "batch",
        input_modes: ["file"],
        selectable: false,
        integration_status: "adapter_required",
      }),
      expect.objectContaining({ id: "infodeliverailab/lab_asr_jp_1", selectable: false }),
      expect.objectContaining({
        id: "infodeliverailab/lab_asr_diarization_v1",
        runtime: "batch",
        selectable: true,
        integration_status: "gpu_validation_required",
      }),
      expect.objectContaining({ id: "infodeliverailab/lab_asr_diarization_v2", selectable: false }),
    ]));
    expect(response.body.data.default_processing_mode).toBe("realtime");
    expect(response.body.data.processing_modes.map((profile: { id: string }) => profile.id))
      .toEqual(["realtime", "batch", "hybrid"]);
    expect(response.body.data.processing_modes.find((profile: { id: string }) => profile.id === "batch"))
      .toMatchObject({
        input_modes: ["file"],
        primary_model_id: "infodeliverailab/lab_asr_diarization_v1",
        final_model_id: null,
        assignments: [{ purpose: "batch", model_id: "infodeliverailab/lab_asr_diarization_v1" }],
        availability: {
          selectable: true,
          configured: false,
          provisionable: false,
          validated: false,
          status: "setup_required",
        },
      });
    expect(response.body.data.processing_modes.find((profile: { id: string }) => profile.id === "realtime"))
      .toMatchObject({
        availability: {
          selectable: true,
          configured: true,
          provisionable: true,
          validated: true,
          status: "configured",
        },
      });
    const hybrid = response.body.data.processing_modes.find((profile: { id: string }) => profile.id === "hybrid");
    expect(hybrid.nodes.map((node: { id: string }) => node.id)).toEqual([
      "audio_ingest",
      "context_asr",
      "streaming_sortformer",
      "vad",
      "endpoint",
      "lab_finalizer",
      "replace_result",
      "persist",
    ]);
    expect(hybrid.edges).toContainEqual({ from: "endpoint", to: "lab_finalizer" });
  });

  it("creates backward-compatible realtime, file-only batch, and fixed hybrid sessions", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const realtime = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      final_model_id: null,
    }).expect(201);
    expect(realtime.body.data).toMatchObject({
      processing_mode: "realtime",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      final_model_id: null,
    });

    await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      processing_mode: "batch",
    }).expect(400);

    const batch = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      processing_mode: "batch",
    }).expect(201);
    expect(batch.body.data).toMatchObject({
      processing_mode: "batch",
      model_id: "infodeliverailab/lab_asr_diarization_v1",
      final_model_id: null,
    });

    const hybrid = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "microphone",
      processing_mode: "hybrid",
    }).expect(201);
    expect(hybrid.body.data).toMatchObject({
      processing_mode: "hybrid",
      model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      final_model_id: "infodeliverailab/lab_asr_diarization_v1",
    });

    await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      processing_mode: "hybrid",
      model_id: "infodeliverailab/lab_asr_diarization_v1",
    }).expect(400);
  });

  it("rejects model ids outside the curated ASR catalog", async () => {
    const agent = request.agent(app);
    await agent.post("/api/session/login").set("origin", "http://localhost").send({ password: "test-password" }).expect(200);

    const response = await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      model_id: "infodeliverailab/diarization_model_0714_ytv2",
    }).expect(400);
    expect(response.body.error.code).toBe("validation_failed");

    await agent.post("/api/transcriptions").set("origin", "http://localhost").send({
      source: "file",
      model_id: "infodeliverailab/qwen3-omni-jp-vllm",
    }).expect(400);
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
    expect(created.body.data).toMatchObject({
      status: "recording",
      processing_mode: "realtime",
      final_model_id: null,
    });
    expect(created.body.data.expires_at).toBe(new Date(clock + 30 * 86_400_000).toISOString());

    const finalPayload = {
      revision: 3,
      text: "あかつき証券の佐藤です。",
      words: [
        { text: "あかつき証券", start_ms: 0, end_ms: 720, speaker: "speaker_1", confidence: 0.98 },
        { text: "の佐藤です", start_ms: 720, end_ms: 1300, speaker: "speaker_1", confidence: 0.97 },
      ],
      context_hits: ["あかつき証券"],
      audio_start_ms: 100,
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
    await agent.put(`/api/transcriptions/${id}/utterances/utt-1`).set("origin", "http://localhost").send({
      ...finalPayload,
      revision: 2,
      text: "古いoutbox再送で上書きしてはいけません。",
    }).expect(200);

    const detail = await agent.get(`/api/transcriptions/${id}`).expect(200);
    expect(detail.body.data.title).toBe("あかつき証券の佐藤です。");
    expect(detail.body.data.utterance_count).toBe(1);
    expect(detail.body.data.utterances).toHaveLength(1);
    expect(detail.body.data.utterances[0].revision).toBe(4);
    expect(detail.body.data.utterances[0].text).toBe("あかつき証券の佐藤でございます。");
    expect(detail.body.data.utterances[0].audio_start_ms).toBe(100);

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

    const lateFailure = await agent.post(`/api/transcriptions/${id}/complete`).set("origin", "http://localhost").send({
      status: "failed",
      duration_ms: 9999,
      metrics: { stable_latency_p95_ms: 9999 },
    }).expect(200);
    expect(lateFailure.body.data.status).toBe("completed");
    expect(lateFailure.body.data.duration_ms).toBe(1300);
    expect(lateFailure.body.data.metrics.stable_latency_p95_ms).toBe(1180);

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
