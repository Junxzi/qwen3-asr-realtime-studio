import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config.js";

describe("configuration", () => {
  it("uses safe mock defaults for local development", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.provider).toBe("mock");
    expect(config.podId).toBe("local-worker");
    expect(config.readyPath).toBe("/ready");
    expect(config.workerLeaseSeconds).toBe(900);
    expect(config.workerProvisionTimeoutSeconds).toBe(300);
  });

  it("refuses live mode without secrets", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      RUNPOD_PROVIDER: "live",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
    })).toThrow("RUNPOD_API_KEY");
  });

  it("allows read-only service probing without an API key when production secrets are set", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      RUNPOD_PROVIDER: "readonly",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      RUNPOD_WORKERS_JSON: "[]",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/asr",
    });
    expect(config.provider).toBe("readonly");
    expect(config.apiKey).toBe("");
  });

  it("rejects default production secrets in read-only mode", () => {
    expect(() => loadConfig({ NODE_ENV: "production", RUNPOD_PROVIDER: "readonly" })).toThrow("CONTROL_PASSWORD");
  });

  it("uses memory history locally and requires a URL for an explicit Postgres store", () => {
    expect(loadConfig({ NODE_ENV: "test" }).transcriptStorage).toBe("memory");
    expect(() => loadConfig({ NODE_ENV: "test", TRANSCRIPT_STORAGE: "postgres" })).toThrow("DATABASE_URL");
    expect(loadConfig({
      NODE_ENV: "test",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/asr",
    }).transcriptStorage).toBe("postgres");
  });

  it("requires durable Postgres state for production worker capacity and leases", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      RUNPOD_PROVIDER: "readonly",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      RUNPOD_WORKERS_JSON: "[]",
    })).toThrow("TRANSCRIPT_STORAGE=postgres");
  });

  it("refuses an implicit legacy Pod target in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      RUNPOD_PROVIDER: "readonly",
      CONTROL_PASSWORD: "production-password",
      SESSION_SECRET: "production-session-secret-at-least-32-characters",
      WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/asr",
    })).toThrow("RUNPOD_WORKERS_JSON");
  });

  it("parses the trusted worker registry and rejects malformed JSON", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_WORKERS_JSON: JSON.stringify([{
        id: "worker-a",
        pod_id: "pod-a",
        name: "A100 worker",
        service_url: "https://pod-a-8000.proxy.runpod.net",
        model_id: "model-a",
        runtime: "realtime",
        max_sessions: 16,
        enabled: true,
      }]),
    });
    expect(config.workers[0]).toMatchObject({ id: "worker-a", podId: "pod-a", maxSessions: 16 });
    expect(config.legacyWorkerMode).toBe(false);
    expect(() => loadConfig({ NODE_ENV: "test", RUNPOD_WORKERS_JSON: "{" })).toThrow("valid JSON");
  });

  it("rejects duplicate non-empty RunPod Pod IDs in the worker registry", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      RUNPOD_WORKERS_JSON: JSON.stringify(["worker-a", "worker-b"].map((id) => ({
        id,
        pod_id: "shared-pod",
        name: id,
        service_url: `https://${id}-8000.proxy.runpod.net`,
        model_id: "model-a",
        runtime: "realtime",
        max_sessions: 1,
        enabled: true,
      }))),
    })).toThrow("duplicate pod_id shared-pod");
  });

  it("allows a dynamic-only pool without reviving the legacy Pod", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_WORKERS_JSON: "[]",
    });
    expect(config.workers).toEqual([]);
    expect(config.legacyWorkerMode).toBe(false);
  });

  it("parses model-specific provisioning templates", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
        model_id: "model-a",
        runtime: "batch",
        template_id: "template-a",
        max_sessions: 1,
      }]),
    });
    expect(config.modelTemplates).toEqual([{
      modelId: "model-a",
      runtime: "batch",
      templateId: "template-a",
      maxSessions: 1,
    }]);
  });

  it("maps the single-template shortcut to the default model in a dynamic-only pool", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_TEMPLATE_ID: "template-context",
    });
    expect(config.modelTemplates).toEqual([{
      modelId: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
      runtime: "realtime",
      templateId: "template-context",
      maxSessions: 32,
    }]);
  });

  it("requires the shared catalog volume for live Context worker provisioning", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_TEMPLATE_ID: "template-context",
    })).toThrow("RUNPOD_NETWORK_VOLUME_ID");
  });

  it("requires the shared model volume for every live batch template", () => {
    const environment = {
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      RUNPOD_WORKERS_JSON: "[]",
      RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
        model_id: "infodeliverailab/lab_asr_diarization_v1",
        runtime: "batch",
        template_id: "template-batch",
        max_sessions: 1,
      }]),
    };

    expect(() => loadConfig(environment)).toThrow("RUNPOD_NETWORK_VOLUME_ID");
    expect(() => loadConfig({
      ...environment,
      RUNPOD_NETWORK_VOLUME_ID: "   ",
    })).toThrow("RUNPOD_NETWORK_VOLUME_ID");
    expect(loadConfig({
      ...environment,
      RUNPOD_NETWORK_VOLUME_ID: "shared-model-volume",
    }).modelTemplates).toEqual([
      expect.objectContaining({ runtime: "batch", templateId: "template-batch" }),
    ]);
  });

  it("does not require a volume setting merely to use an existing static batch Pod", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNPOD_PROVIDER: "live",
      RUNPOD_API_KEY: "runpod-api-key",
      RUNPOD_WORKER_ADMIN_SECRET: "worker-admin-secret-at-least-32-characters",
      RUNPOD_WORKERS_JSON: JSON.stringify([{
        id: "static-batch",
        pod_id: "pod-static-batch",
        name: "Existing batch Pod",
        service_url: "https://pod-static-batch-8000.proxy.runpod.net",
        model_id: "infodeliverailab/lab_asr_diarization_v1",
        runtime: "batch",
        max_sessions: 1,
        enabled: true,
      }]),
    });

    expect(config.runpodNetworkVolumeId).toBe("");
    expect(config.workers).toEqual([
      expect.objectContaining({ id: "static-batch", runtime: "batch" }),
    ]);
    expect(config.modelTemplates).toEqual([]);
  });

  it("keeps idle Pod auto-stop opt-in", () => {
    expect(loadConfig({ NODE_ENV: "test" }).autoStopIdleWorkers).toBe(false);
    expect(loadConfig({
      NODE_ENV: "test",
      RUNPOD_AUTO_STOP_IDLE: "true",
    }).autoStopIdleWorkers).toBe(true);
  });
});
