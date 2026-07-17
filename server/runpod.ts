import type { AppConfig } from "./config.js";
import type { DesiredStatus, PodInfo, PodProvider, ServiceProbe } from "./types.js";

export class ProviderError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}

async function probeRunPodService(config: AppConfig, fetcher: typeof fetch): Promise<ServiceProbe> {
  try {
    const response = await fetcher(`${config.serviceUrl}${config.readyPath}`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3500),
    });
    let health: Record<string, unknown> | undefined;
    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) health = await response.json() as Record<string, unknown>;
    }
    return { ready: response.ok, status: response.status, health, message: response.ok ? undefined : `health ${response.status}` };
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : "service unavailable" };
  }
}

export class LiveRunPodProvider implements PodProvider {
  constructor(private config: AppConfig, private fetcher: typeof fetch = fetch) {}

  private async request(path: string, init?: RequestInit) {
    const response = await this.fetcher(`${this.config.apiBase}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.config.apiKey}`, ...init?.headers },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ProviderError("runpod_api_failed", `RunPod API ${response.status}: ${body.slice(0, 180)}`, 502);
    }
    return response;
  }

  async getPod(): Promise<PodInfo> {
    const response = await this.request(`/pods/${encodeURIComponent(this.config.podId)}`);
    const payload = await response.json() as PodInfo;
    return payload;
  }

  async startPod() {
    await this.request(`/pods/${encodeURIComponent(this.config.podId)}/start`, { method: "POST" });
  }

  async stopPod() {
    await this.request(`/pods/${encodeURIComponent(this.config.podId)}/stop`, { method: "POST" });
  }

  async probeService(): Promise<ServiceProbe> {
    return probeRunPodService(this.config, this.fetcher);
  }
}

export class ReadonlyRunPodProvider implements PodProvider {
  constructor(private config: AppConfig, private fetcher: typeof fetch = fetch) {}

  async getPod(): Promise<PodInfo> {
    return {
      id: this.config.podId,
      name: this.config.workers[0]?.name ?? "configured Qwen worker",
      desiredStatus: "EXITED",
    };
  }

  async startPod(): Promise<void> {
    throw new ProviderError("runpod_control_unavailable", "RunPod APIキーが未設定のためGPUを起動できません", 503);
  }

  async stopPod(): Promise<void> {
    throw new ProviderError("runpod_control_unavailable", "RunPod APIキーが未設定のためGPUを停止できません", 503);
  }

  async probeService(): Promise<ServiceProbe> {
    return probeRunPodService(this.config, this.fetcher);
  }
}

export class MockRunPodProvider implements PodProvider {
  private desiredStatus: DesiredStatus;
  private startedAt = 0;
  public startCalls = 0;
  public stopCalls = 0;

  constructor(private config: AppConfig, private now: () => number = Date.now) {
    this.desiredStatus = config.mockInitialStatus;
    if (this.desiredStatus === "RUNNING") this.startedAt = this.now() - config.mockReadyDelayMs;
  }

  async getPod(): Promise<PodInfo> {
    return {
      id: this.config.podId,
      name: "qwen3asr_fintuning-migration-migration",
      desiredStatus: this.desiredStatus,
      costPerHr: "1.69",
      gpu: this.desiredStatus === "RUNNING" ? { id: "A100-SXM4-80GB", displayName: "NVIDIA A100 80GB", count: 1 } : null,
    };
  }

  async startPod() {
    this.startCalls += 1;
    this.desiredStatus = "RUNNING";
    this.startedAt = this.now();
  }

  async stopPod() {
    this.stopCalls += 1;
    this.desiredStatus = "EXITED";
    this.startedAt = 0;
  }

  async probeService(): Promise<ServiceProbe> {
    const ready = this.desiredStatus === "RUNNING" && this.now() - this.startedAt >= this.config.mockReadyDelayMs;
    return {
      ready,
      status: ready ? 200 : 503,
      message: ready ? undefined : "モデルをGPUへロードしています",
      health: ready ? {
        worker_id: this.config.workers[0]?.id || this.config.podId,
        model_id: this.config.workers[0]?.modelId,
        accelerator: "RunPod A100 80GB",
        backend: "qwen_async_vllm",
        catalog_revision: "securities-terms-93b1402b7a39",
        catalog_terms: 248,
        chunk_seconds: 1,
        inference_mode: "real",
        gpu_utilization_percent: 62,
        gpu_memory_used_mb: 31_744,
        gpu_memory_total_mb: 81_920,
        gpu_temperature_c: 48,
        gpu_power_w: 286,
      } : undefined,
    };
  }
}

export function createProvider(config: AppConfig): PodProvider {
  if (config.provider === "live") return new LiveRunPodProvider(config);
  if (config.provider === "readonly") return new ReadonlyRunPodProvider(config);
  return new MockRunPodProvider(config);
}
