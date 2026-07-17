import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config.js";
import { HttpWorkerAdminClient, LiveRunPodFleetClient } from "../../server/worker-clients.js";
import type { WorkerRecord } from "../../server/types.js";

const contextModelId = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";

function workerRecord(): WorkerRecord {
  return {
    id: "worker-1",
    podId: "pod-1",
    name: "Worker 1",
    serviceUrl: "https://pod-1-8000.proxy.runpod.net",
    modelId: "model-1",
    runtime: "realtime",
    origin: "static",
    status: "ready",
    maxSessions: 32,
    activeSessions: 0,
    enabled: true,
    gpu: null,
    health: null,
    lastHeartbeatAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RunPod fleet client", () => {
  it("starts a pod and creates a worker from the configured template", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/pods")) {
        return new Response(JSON.stringify({ id: "new-pod", desiredStatus: "RUNNING" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    };
    const config = loadConfig({
      NODE_ENV: "production",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
        model_id: "model-1",
        runtime: "realtime",
        template_id: "template-1",
        max_sessions: 32,
      }]),
      RUNPOD_NETWORK_VOLUME_ID: "volume-1",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
    });
    const client = new LiveRunPodFleetClient(config, fetcher as typeof fetch);

    await client.startPod("pod-1");
    const created = await client.createPod({ name: "worker", workerId: "worker-1", modelId: "model-1", runtime: "realtime" });

    expect(created.id).toBe("new-pod");
    expect(calls[0].url.endsWith("/pods/pod-1/start")).toBe(true);
    expect(calls[0].init?.method).toBe("POST");
    const createBody = JSON.parse(String(calls[1].init?.body));
    expect(createBody).toMatchObject({
      templateId: "template-1",
      networkVolumeId: "volume-1",
      gpuCount: 1,
      env: {
        WORKER_ID: "worker-1",
        MODEL_ID: "model-1",
        WORKER_RUNTIME: "realtime",
      },
    });
    expect(JSON.stringify(createBody)).not.toContain("worker-admin-secret-at-least-32-characters");
    expect(calls[1].init?.headers).toMatchObject({ authorization: "Bearer runpod-api-key" });
  });

  it("never calls the RunPod create API for a batch template without a Network Volume", async () => {
    let calls = 0;
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "mock",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
        model_id: "infodeliverailab/lab_asr_diarization_v1",
        runtime: "batch",
        template_id: "template-batch",
        max_sessions: 1,
      }]),
    });
    const client = new LiveRunPodFleetClient(config, (async () => {
      calls += 1;
      return jsonResponse({ id: "must-not-exist" });
    }) as typeof fetch);

    await expect(client.createPod({
      name: "batch-worker",
      workerId: "batch-worker-1",
      modelId: "infodeliverailab/lab_asr_diarization_v1",
      runtime: "batch",
    })).rejects.toMatchObject({
      code: "runpod_network_volume_required",
      status: 503,
    });
    expect(calls).toBe(0);
  });

  it("finds exactly one active Pod by the WORKER_ID environment value", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([
        { id: "pod-other", desiredStatus: "RUNNING", env: { WORKER_ID: "worker-other" } },
        { id: "pod-old", desiredStatus: "TERMINATED", env: { WORKER_ID: "worker-target" } },
        { id: "pod-target", desiredStatus: "RUNNING", env: { WORKER_ID: "worker-target" } },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const config = loadConfig({
      NODE_ENV: "production",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
    });
    const client = new LiveRunPodFleetClient(config, fetcher as typeof fetch);

    await expect(client.findPodByWorkerId("worker-target")).resolves.toMatchObject({ id: "pod-target" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith("/pods")).toBe(true);
    expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer runpod-api-key" });
  });

  it("fails loudly when multiple active Pods advertise the same WORKER_ID", async () => {
    const fetcher = async () => new Response(JSON.stringify([
      { id: "pod-one", desiredStatus: "RUNNING", env: { WORKER_ID: "worker-duplicate" } },
      { id: "pod-two", desiredStatus: "EXITED", env: { WORKER_ID: "worker-duplicate" } },
    ]), { status: 200, headers: { "content-type": "application/json" } });
    const config = loadConfig({
      NODE_ENV: "production",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
    });
    const client = new LiveRunPodFleetClient(config, fetcher as typeof fetch);

    await expect(client.findPodByWorkerId("worker-duplicate")).rejects.toMatchObject({
      code: "runpod_duplicate_worker_pods",
      status: 502,
    });
  });

  it("sends the explicit drain request body required by the worker API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    };
    const worker = workerRecord();
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    await client.drain(worker);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://pod-1-8000.proxy.runpod.net/admin/drain");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer worker-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ draining: true }),
    });
  });

  it("fails closed when the worker does not implement the readiness contract", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/ready?model_id=model-1")) {
        return jsonResponse({ status: "not_found" }, 404);
      }
      return jsonResponse({
        status: "ok",
        worker_id: "worker-1",
        model_id: "model-1",
        model_loaded: true,
      });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(workerRecord());

    expect(probe).toMatchObject({
      ready: false,
      operational: false,
      status: 404,
      workerId: "worker-1",
      modelId: "model-1",
    });
  });

  it("cancels a chunked worker response as soon as it exceeds 64 KiB", async () => {
    let pulls = 0;
    let cancelled = false;
    const fetcher = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40 * 1024));
        if (pulls >= 10) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(workerRecord());

    expect(probe.ready).toBe(false);
    expect(probe.message).toContain("64 KiB");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("rejects an otherwise-ready response when worker identity is absent", async () => {
    const fetcher = async (input: string | URL | Request) => {
      if (String(input).includes("/ready?")) {
        return jsonResponse({
          status: "ready",
          model_loaded: true,
          model_match: true,
          accepting_sessions: true,
        });
      }
      return jsonResponse({ status: "ok" });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(workerRecord());

    expect(probe).toMatchObject({
      ready: false,
      operational: false,
      message: "worker identity or model is missing or mismatched",
    });
  });

  it("requires a nonempty catalog revision for the Context model", async () => {
    const worker = { ...workerRecord(), modelId: contextModelId };
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ready?")) {
        return jsonResponse({
          status: "ready",
          worker_id: worker.id,
          model_id: contextModelId,
          model_loaded: true,
          model_match: true,
          catalog_required: true,
          catalog_ready: true,
          accepting_sessions: true,
        });
      }
      return jsonResponse({ status: "ok", worker_id: worker.id, model_id: contextModelId });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(worker);

    expect(probe).toMatchObject({
      ready: false,
      operational: false,
      message: "required Context catalog is not ready",
    });
  });

  it("rejects development inference when real inference is required", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ready?")) {
        return jsonResponse({
          status: "ready",
          worker_id: "worker-1",
          model_id: "model-1",
          model_loaded: true,
          model_match: true,
          accepting_sessions: true,
        });
      }
      return jsonResponse({
        status: "ok",
        worker_id: "worker-1",
        model_id: "model-1",
        inference_mode: "development",
      });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch, true);

    const probe = await client.probe(workerRecord());

    expect(probe).toMatchObject({
      ready: false,
      operational: false,
      message: "worker is not running real inference",
    });
  });

  it("reports a capacity-full worker as operational but not allocatable", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/ready?model_id=model-1")) {
        return jsonResponse({
          status: "not_ready",
          worker_id: "worker-1",
          model_id: "model-1",
          model_loaded: true,
          model_match: true,
          accepting_sessions: false,
          draining: false,
          active_sessions: 32,
          max_sessions: 32,
        }, 503);
      }
      return jsonResponse({
        status: "ok",
        worker_id: "worker-1",
        model_id: "model-1",
        model_loaded: true,
      });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(workerRecord());

    expect(probe).toMatchObject({
      ready: false,
      operational: true,
      atCapacity: true,
      status: 503,
      reportedActiveSessions: 32,
      reportedMaxSessions: 32,
    });
  });

  it("does not treat capacity as operational when a required catalog is unavailable", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/ready?model_id=model-1")) {
        return jsonResponse({
          status: "not_ready",
          worker_id: "worker-1",
          model_id: "model-1",
          model_loaded: true,
          model_match: true,
          catalog_required: true,
          catalog_ready: false,
          accepting_sessions: false,
          draining: false,
          active_sessions: 32,
          max_sessions: 32,
        }, 503);
      }
      return jsonResponse({ status: "ok" });
    };
    const client = new HttpWorkerAdminClient("worker-admin-secret", fetcher as typeof fetch);

    const probe = await client.probe(workerRecord());

    expect(probe).toMatchObject({
      ready: false,
      operational: false,
      atCapacity: true,
      status: 503,
    });
  });
});
