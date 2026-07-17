import type { AppConfig } from "./config.js";
import { DEFAULT_ASR_MODEL_ID } from "./asr-models.js";
import { ProviderError } from "./runpod.js";
import type { PodInfo, PodProvider, ServiceProbe, WorkerRecord } from "./types.js";

export interface CreateRunPodInput {
  name: string;
  workerId: string;
  modelId: string;
  runtime: "realtime" | "batch";
}

export interface RunPodFleetClient {
  canMutate: boolean;
  canCreate(modelId: string, runtime: "realtime" | "batch"): boolean;
  getPod(podId: string): Promise<PodInfo>;
  findPodByWorkerId(workerId: string): Promise<PodInfo | null>;
  startPod(podId: string): Promise<void>;
  stopPod(podId: string): Promise<void>;
  createPod(input: CreateRunPodInput): Promise<PodInfo>;
}

export interface WorkerProbe extends ServiceProbe {
  operational?: boolean;
  atCapacity?: boolean;
  reportedActiveSessions?: number;
  reportedMaxSessions?: number;
  modelId?: string;
  workerId?: string;
}

export interface WorkerAdminClient {
  probe(worker: WorkerRecord): Promise<WorkerProbe>;
  drain(worker: WorkerRecord): Promise<void>;
}

async function readJson(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  const maximumBytes = 64 * 1024;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("worker response exceeds the 64 KiB limit");
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel("worker response exceeds the 64 KiB limit");
      throw new Error("worker response exceeds the 64 KiB limit");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export class HttpWorkerAdminClient implements WorkerAdminClient {
  constructor(
    private adminSecret: string,
    private fetcher: typeof fetch = fetch,
    private requireRealInference = false,
  ) {}

  async probe(worker: WorkerRecord): Promise<WorkerProbe> {
    try {
      const healthResponse = await this.fetcher(`${worker.serviceUrl}/health`, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      let health = await readJson(healthResponse);
      if (!healthResponse.ok) return { ready: false, status: healthResponse.status, health, message: `health ${healthResponse.status}` };
      try {
        const detailsResponse = await this.fetcher(`${worker.serviceUrl}/healthz`, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        });
        if (detailsResponse.ok) health = { ...health, ...await readJson(detailsResponse) };
      } catch {
        // Detailed telemetry is optional; liveness and readiness remain authoritative.
      }
      const readyResponse = await this.fetcher(`${worker.serviceUrl}/ready?model_id=${encodeURIComponent(worker.modelId)}`, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      const readyBody = await readJson(readyResponse);
      const merged = { ...health, ...readyBody };
      const reportedActiveSessions = nonNegativeInteger(readyBody?.active_sessions);
      const reportedMaxSessions = positiveInteger(readyBody?.max_sessions);
      const atCapacity = reportedActiveSessions !== undefined
        && reportedMaxSessions !== undefined
        && reportedActiveSessions >= reportedMaxSessions;
      const modelId = typeof merged.model_id === "string" ? merged.model_id : typeof merged.model === "string" ? merged.model : undefined;
      const workerId = typeof merged.worker_id === "string" ? merged.worker_id : undefined;
      const identityOperational = workerId === worker.id && modelId === worker.modelId;
      const revision = typeof merged.catalog_revision === "string" ? merged.catalog_revision.trim() : "";
      const catalogOperational = readyBody?.catalog_required !== true || readyBody?.catalog_ready === true;
      const contextCatalogOperational = worker.modelId !== DEFAULT_ASR_MODEL_ID || (
        readyBody?.catalog_required === true
        && readyBody?.catalog_ready === true
        && revision.length > 0
        && revision !== "empty"
      );
      const inferenceOperational = !this.requireRealInference || merged.inference_mode === "real";
      const ready = readyResponse.ok
        && readyBody?.status === "ready"
        && readyBody?.accepting_sessions === true
        && readyBody?.model_loaded === true
        && readyBody?.model_match === true
        && catalogOperational
        && contextCatalogOperational
        && identityOperational
        && inferenceOperational;
      const operationalAtCapacity = readyResponse.status === 503
        && readyBody?.status === "not_ready"
        && readyBody?.model_loaded === true
        && readyBody?.model_match === true
        && readyBody?.draining !== true
        && catalogOperational
        && contextCatalogOperational
        && identityOperational
        && inferenceOperational
        && atCapacity;
      const operational = ready || operationalAtCapacity;
      return {
        ready,
        operational,
        atCapacity,
        ...(reportedActiveSessions !== undefined ? { reportedActiveSessions } : {}),
        ...(reportedMaxSessions !== undefined ? { reportedMaxSessions } : {}),
        status: readyResponse.status,
        health: merged,
        modelId,
        workerId,
        message: ready
          ? undefined
          : !identityOperational
            ? "worker identity or model is missing or mismatched"
            : !contextCatalogOperational
              ? "required Context catalog is not ready"
              : !inferenceOperational
                ? "worker is not running real inference"
                : operationalAtCapacity ? "worker is at capacity" : "worker is not ready",
      };
    } catch (error) {
      return {
        ready: false,
        operational: false,
        message: error instanceof Error ? error.message : "worker unavailable",
      };
    }
  }

  private async mutate(worker: WorkerRecord, path: string, body?: Record<string, unknown>) {
    if (!this.adminSecret) throw new ProviderError("worker_admin_unavailable", "ワーカー管理シークレットが設定されていません", 503);
    const response = await this.fetcher(`${worker.serviceUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminSecret}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ProviderError("worker_admin_failed", `ワーカー管理APIが ${response.status} を返しました`, 502);
  }

  async drain(worker: WorkerRecord) {
    await this.mutate(worker, "/admin/drain", { draining: true });
  }
}

export class LiveRunPodFleetClient implements RunPodFleetClient {
  readonly canMutate = true;

  constructor(private config: AppConfig, private fetcher: typeof fetch = fetch) {}

  canCreate(modelId: string, runtime: "realtime" | "batch") {
    return this.config.modelTemplates.some((profile) => profile.modelId === modelId && profile.runtime === runtime);
  }

  private async request(path: string, init?: RequestInit) {
    const response = await this.fetcher(`${this.config.apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ProviderError("runpod_api_failed", `RunPod API ${response.status}`, 502);
    return response;
  }

  async getPod(podId: string) {
    const response = await this.request(`/pods/${encodeURIComponent(podId)}`);
    return await response.json() as PodInfo;
  }

  async findPodByWorkerId(workerId: string) {
    const response = await this.request("/pods");
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) {
      throw new ProviderError("runpod_api_invalid_response", "RunPod API did not return a Pod list", 502);
    }
    const matches = payload.filter((candidate): candidate is PodInfo => {
      if (!candidate || typeof candidate !== "object") return false;
      const pod = candidate as Partial<PodInfo>;
      return typeof pod.id === "string"
        && pod.id.length > 0
        && pod.desiredStatus !== "TERMINATED"
        && pod.env !== null
        && typeof pod.env === "object"
        && pod.env.WORKER_ID === workerId;
    });
    if (matches.length > 1) {
      throw new ProviderError(
        "runpod_duplicate_worker_pods",
        `Multiple active RunPod Pods advertise WORKER_ID ${workerId}`,
        502,
      );
    }
    return matches[0] ?? null;
  }

  async startPod(podId: string) {
    await this.request(`/pods/${encodeURIComponent(podId)}/start`, { method: "POST" });
  }

  async stopPod(podId: string) {
    await this.request(`/pods/${encodeURIComponent(podId)}/stop`, { method: "POST" });
  }

  async createPod(input: CreateRunPodInput) {
    const profile = this.config.modelTemplates.find((candidate) => (
      candidate.modelId === input.modelId && candidate.runtime === input.runtime
    ));
    if (!profile) throw new ProviderError("runpod_template_missing", "このモデル用のRunPod Templateが設定されていません", 503);
    const env: Record<string, string> = {
      WORKER_ID: input.workerId,
      MODEL_ID: input.modelId,
      WORKER_RUNTIME: input.runtime,
    };
    const response = await this.request("/pods", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        templateId: profile.templateId,
        ...(this.config.runpodNetworkVolumeId ? { networkVolumeId: this.config.runpodNetworkVolumeId } : {}),
        cloudType: "SECURE",
        gpuCount: 1,
        gpuTypeIds: this.config.gpuTypes,
        env,
      }),
    });
    return await response.json() as PodInfo;
  }
}

export class ProviderFleetAdapter implements RunPodFleetClient {
  constructor(private provider: PodProvider, private legacyPodId: string, public readonly canMutate: boolean) {}

  canCreate() { return false; }

  async findPodByWorkerId(workerId: string) {
    void workerId;
    return null;
  }

  async getPod(podId: string) {
    if (podId !== this.legacyPodId) throw new ProviderError("runpod_pod_unknown", "登録されていないPodです", 404);
    return await this.provider.getPod();
  }

  async startPod(podId: string) {
    if (!this.canMutate || podId !== this.legacyPodId) throw new ProviderError("runpod_control_unavailable", "このPodは自動起動できません", 503);
    await this.provider.startPod();
  }

  async stopPod(podId: string) {
    if (!this.canMutate || podId !== this.legacyPodId) throw new ProviderError("runpod_control_unavailable", "このPodは自動停止できません", 503);
    await this.provider.stopPod();
  }

  async createPod(): Promise<PodInfo> {
    throw new ProviderError("runpod_template_missing", "RunPod Templateが設定されていません", 503);
  }
}

export class ProviderWorkerAdminAdapter implements WorkerAdminClient {
  constructor(private provider: PodProvider, private legacyWorkerId: string) {}

  async probe(worker: WorkerRecord) {
    if (worker.id !== this.legacyWorkerId) return { ready: false, message: "worker unavailable" };
    const probe = await this.provider.probeService();
    const modelId = typeof probe.health?.model_id === "string"
      ? probe.health.model_id
      : typeof probe.health?.model === "string" ? probe.health.model : undefined;
    const workerId = typeof probe.health?.worker_id === "string" ? probe.health.worker_id : undefined;
    return { ...probe, modelId, workerId };
  }

  async drain(): Promise<void> {
    throw new ProviderError("worker_admin_unavailable", "mock worker does not support draining", 503);
  }
}

export function createFleetClient(config: AppConfig, provider: PodProvider): RunPodFleetClient {
  if (config.provider === "live") return new LiveRunPodFleetClient(config);
  return new ProviderFleetAdapter(provider, config.podId, config.provider === "mock");
}

export function createWorkerAdminClient(config: AppConfig, provider: PodProvider): WorkerAdminClient {
  if (
    config.provider === "mock"
    || (config.provider === "readonly" && config.legacyWorkerMode && config.nodeEnv !== "production")
  ) {
    return new ProviderWorkerAdminAdapter(provider, config.workers[0]?.id || "");
  }
  return new HttpWorkerAdminClient(config.workerAdminSecret, fetch, config.nodeEnv === "production");
}
