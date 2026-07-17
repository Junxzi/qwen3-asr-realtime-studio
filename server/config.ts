import { z } from "zod";
import { DEFAULT_ASR_MODEL_ID } from "./asr-models.js";

const workerRuntimeSchema = z.enum(["realtime", "batch"]);
const modelTemplateSchema = z.object({
  model_id: z.string().min(1).max(240),
  runtime: workerRuntimeSchema,
  template_id: z.string().min(1).max(200),
  max_sessions: z.number().int().positive().max(256),
});
const knownWorkerSchema = z.object({
  id: z.string().min(1).max(160),
  pod_id: z.string().min(1).max(160).default(""),
  name: z.string().min(1).max(200),
  service_url: z.string().url(),
  model_id: z.string().min(1).max(240),
  runtime: workerRuntimeSchema,
  max_sessions: z.number().int().positive().max(256),
  enabled: z.boolean().default(true),
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  RUNPOD_PROVIDER: z.enum(["mock", "readonly", "live"]).default("mock"),
  RUNPOD_API_BASE: z.string().url().default("https://rest.runpod.io/v1"),
  RUNPOD_API_KEY: z.string().default(""),
  RUNPOD_POD_ID: z.string().min(3).default("local-worker"),
  RUNPOD_SERVICE_URL: z.string().url().default("http://127.0.0.1:8000"),
  RUNPOD_READY_PATH: z.string().startsWith("/").default("/ready"),
  RUNPOD_WORKERS_JSON: z.string().default(""),
  RUNPOD_TEMPLATE_ID: z.string().default(""),
  RUNPOD_MODEL_TEMPLATES_JSON: z.string().default(""),
  RUNPOD_NETWORK_VOLUME_ID: z.string().default(""),
  RUNPOD_POOL_MAX_WORKERS: z.coerce.number().int().positive().max(64).default(4),
  RUNPOD_WORKER_PORT: z.coerce.number().int().positive().max(65535).default(8000),
  RUNPOD_WORKER_ADMIN_SECRET: z.string().default(""),
  WORKER_TICKET_SECRET: z.string().default(""),
  WORKER_TICKET_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(120),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
  WORKER_PROVISION_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  WORKER_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().max(300000).default(10000),
  WORKER_REAPER_INTERVAL_MS: z.coerce.number().int().positive().max(300000).default(30000),
  RUNPOD_GPU_TYPES: z.string().default("NVIDIA A100 80GB PCIe,NVIDIA A100-SXM4-80GB"),
  CONTROL_PASSWORD: z.string().min(8).default("change-me"),
  SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(43200),
  ALLOWED_ORIGIN: z.string().default(""),
  DATABASE_URL: z.string().default(""),
  TRANSCRIPT_STORAGE: z.enum(["auto", "memory", "postgres"]).default("auto"),
  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().max(365).default(30),
  TRANSCRIPT_STALE_MINUTES: z.coerce.number().int().positive().max(1440).default(10),
  MOCK_INITIAL_STATUS: z.enum(["EXITED", "RUNNING"]).default("EXITED"),
  MOCK_READY_DELAY_MS: z.coerce.number().int().nonnegative().default(2500),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  let configuredWorkers: z.infer<typeof knownWorkerSchema>[] | null = null;
  if (value.RUNPOD_WORKERS_JSON.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.RUNPOD_WORKERS_JSON);
    } catch {
      throw new Error("RUNPOD_WORKERS_JSON must be valid JSON");
    }
    configuredWorkers = z.array(knownWorkerSchema).max(64).parse(parsed);
  }
  const legacyWorkerMode = configuredWorkers === null;
  let configuredTemplates: z.infer<typeof modelTemplateSchema>[] = [];
  if (value.RUNPOD_MODEL_TEMPLATES_JSON.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.RUNPOD_MODEL_TEMPLATES_JSON);
    } catch {
      throw new Error("RUNPOD_MODEL_TEMPLATES_JSON must be valid JSON");
    }
    configuredTemplates = z.array(modelTemplateSchema).max(64).parse(parsed);
  }
  const transcriptStorage = value.TRANSCRIPT_STORAGE === "auto"
    ? (value.DATABASE_URL ? "postgres" : "memory")
    : value.TRANSCRIPT_STORAGE;
  if (value.NODE_ENV === "production") {
    if (value.CONTROL_PASSWORD === "change-me") throw new Error("CONTROL_PASSWORD must be changed in production");
    if (value.SESSION_SECRET.length < 32 || value.SESSION_SECRET.includes("change-me")) {
      throw new Error("SESSION_SECRET must be a unique value of at least 32 characters in production");
    }
    if (value.WORKER_TICKET_SECRET.length < 32) {
      throw new Error("WORKER_TICKET_SECRET must be an independent value of at least 32 characters in production");
    }
    if (value.WORKER_TICKET_SECRET === value.SESSION_SECRET) {
      throw new Error("WORKER_TICKET_SECRET and SESSION_SECRET must be different in production");
    }
  }
  if (value.RUNPOD_PROVIDER === "live") {
    if (!value.RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY is required in live mode");
    if (value.RUNPOD_WORKER_ADMIN_SECRET.length < 32) {
      throw new Error("RUNPOD_WORKER_ADMIN_SECRET must be at least 32 characters in live mode");
    }
  }
  if (value.NODE_ENV === "production" && configuredWorkers === null) {
    throw new Error("RUNPOD_WORKERS_JSON must be explicitly set to a trusted worker array or [] in production");
  }
  if (transcriptStorage === "postgres" && !value.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when TRANSCRIPT_STORAGE=postgres");
  }
  if (value.NODE_ENV === "production" && transcriptStorage !== "postgres") {
    throw new Error("TRANSCRIPT_STORAGE=postgres and DATABASE_URL are required in production");
  }
  const workers = (configuredWorkers ?? [{
    id: value.RUNPOD_POD_ID,
    pod_id: value.RUNPOD_POD_ID,
    name: "local Qwen worker",
    service_url: value.RUNPOD_SERVICE_URL,
    model_id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
    runtime: "realtime" as const,
    max_sessions: 32,
    enabled: true,
  }]).map((worker) => ({
    id: worker.id,
    podId: worker.pod_id,
    name: worker.name,
    serviceUrl: worker.service_url.replace(/\/$/, ""),
    modelId: worker.model_id,
    runtime: worker.runtime,
    maxSessions: worker.max_sessions,
    enabled: worker.enabled,
  }));
  const workerIdByPodId = new Map<string, string>();
  for (const worker of workers) {
    if (!worker.podId) continue;
    const owner = workerIdByPodId.get(worker.podId);
    if (owner && owner !== worker.id) {
      throw new Error(`RUNPOD_WORKERS_JSON contains duplicate pod_id ${worker.podId}`);
    }
    workerIdByPodId.set(worker.podId, worker.id);
  }
  for (const worker of workers) {
    const serviceUrl = new URL(worker.serviceUrl);
    if (serviceUrl.username || serviceUrl.password || serviceUrl.search || serviceUrl.hash || serviceUrl.pathname !== "/") {
      throw new Error(`worker ${worker.id} service_url must be an origin without credentials, path, query, or fragment`);
    }
    if (value.NODE_ENV === "production" && (
      serviceUrl.protocol !== "https:"
      || !serviceUrl.hostname.endsWith(".proxy.runpod.net")
    )) throw new Error(`worker ${worker.id} service_url must use an HTTPS RunPod proxy origin in production`);
  }
  if (value.NODE_ENV === "production" && value.RUNPOD_PROVIDER === "live") {
    const apiUrl = new URL(value.RUNPOD_API_BASE);
    if (apiUrl.protocol !== "https:" || apiUrl.hostname !== "rest.runpod.io" || apiUrl.username || apiUrl.password) {
      throw new Error("RUNPOD_API_BASE must use the official HTTPS rest.runpod.io origin in production");
    }
  }
  const templateMap = new Map(configuredTemplates.map((template) => [
    `${template.runtime}:${template.model_id}`,
    {
      modelId: template.model_id,
      runtime: template.runtime,
      templateId: template.template_id,
      maxSessions: template.max_sessions,
    },
  ]));
  if (value.RUNPOD_TEMPLATE_ID) {
    const defaultTemplateWorker = workers[0] ?? {
      runtime: "realtime" as const,
      modelId: DEFAULT_ASR_MODEL_ID,
      maxSessions: 32,
    };
    const key = `${defaultTemplateWorker.runtime}:${defaultTemplateWorker.modelId}`;
    if (!templateMap.has(key)) templateMap.set(key, {
      modelId: defaultTemplateWorker.modelId,
      runtime: defaultTemplateWorker.runtime,
      templateId: value.RUNPOD_TEMPLATE_ID,
      maxSessions: defaultTemplateWorker.maxSessions,
    });
  }
  if (
    value.RUNPOD_PROVIDER === "live"
    && templateMap.has(`realtime:${DEFAULT_ASR_MODEL_ID}`)
    && !value.RUNPOD_NETWORK_VOLUME_ID
  ) {
    throw new Error("RUNPOD_NETWORK_VOLUME_ID is required to provision the Context Full-FT worker and catalog");
  }
  const workerTicketSecret = value.WORKER_TICKET_SECRET || value.SESSION_SECRET;
  if (workers.filter((worker) => worker.enabled).length > value.RUNPOD_POOL_MAX_WORKERS) {
    throw new Error("RUNPOD_POOL_MAX_WORKERS cannot be less than the enabled worker count");
  }
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    provider: value.RUNPOD_PROVIDER,
    apiBase: value.RUNPOD_API_BASE.replace(/\/$/, ""),
    apiKey: value.RUNPOD_API_KEY,
    podId: value.RUNPOD_POD_ID,
    serviceUrl: value.RUNPOD_SERVICE_URL.replace(/\/$/, ""),
    readyPath: value.RUNPOD_READY_PATH,
    legacyWorkerMode,
    workers,
    modelTemplates: [...templateMap.values()],
    runpodNetworkVolumeId: value.RUNPOD_NETWORK_VOLUME_ID,
    workerPoolMaxWorkers: value.RUNPOD_POOL_MAX_WORKERS,
    workerPort: value.RUNPOD_WORKER_PORT,
    workerAdminSecret: value.RUNPOD_WORKER_ADMIN_SECRET,
    workerTicketSecret,
    workerTicketTtlSeconds: value.WORKER_TICKET_TTL_SECONDS,
    workerLeaseSeconds: value.WORKER_LEASE_SECONDS,
    workerProvisionTimeoutSeconds: value.WORKER_PROVISION_TIMEOUT_SECONDS,
    workerReconcileIntervalMs: value.WORKER_RECONCILE_INTERVAL_MS,
    workerReaperIntervalMs: value.WORKER_REAPER_INTERVAL_MS,
    gpuTypes: value.RUNPOD_GPU_TYPES.split(",").map((item) => item.trim()).filter(Boolean),
    controlPassword: value.CONTROL_PASSWORD,
    sessionSecret: value.SESSION_SECRET,
    sessionTtlSeconds: value.SESSION_TTL_SECONDS,
    allowedOrigin: value.ALLOWED_ORIGIN.replace(/\/$/, ""),
    databaseUrl: value.DATABASE_URL,
    transcriptStorage,
    transcriptRetentionDays: value.TRANSCRIPT_RETENTION_DAYS,
    transcriptStaleMinutes: value.TRANSCRIPT_STALE_MINUTES,
    mockInitialStatus: value.MOCK_INITIAL_STATUS,
    mockReadyDelayMs: value.MOCK_READY_DELAY_MS,
  } as const;
}
