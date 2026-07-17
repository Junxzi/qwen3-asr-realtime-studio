import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  RUNPOD_PROVIDER: z.enum(["mock", "readonly", "live"]).default("mock"),
  RUNPOD_API_BASE: z.string().url().default("https://rest.runpod.io/v1"),
  RUNPOD_API_KEY: z.string().default(""),
  RUNPOD_POD_ID: z.string().min(3).default("nhf73n5jvajgyj"),
  RUNPOD_SERVICE_URL: z.string().url().default("https://nhf73n5jvajgyj-8000.proxy.runpod.net"),
  RUNPOD_READY_PATH: z.string().startsWith("/").default("/health"),
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
  const transcriptStorage = value.TRANSCRIPT_STORAGE === "auto"
    ? (value.DATABASE_URL ? "postgres" : "memory")
    : value.TRANSCRIPT_STORAGE;
  if (value.RUNPOD_PROVIDER === "live") {
    if (!value.RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY is required in live mode");
    if (value.CONTROL_PASSWORD === "change-me") throw new Error("CONTROL_PASSWORD must be changed in live mode");
    if (value.SESSION_SECRET.length < 32 || value.SESSION_SECRET.includes("change-me")) {
      throw new Error("SESSION_SECRET must be a unique value of at least 32 characters in live mode");
    }
  }
  if (transcriptStorage === "postgres" && !value.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when TRANSCRIPT_STORAGE=postgres");
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
