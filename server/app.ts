import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { DEFAULT_ASR_MODEL_ID, listAsrModels } from "./asr-models.js";
import { clearSessionCookie, passwordMatches, requireAllowedOrigin, requireAuth, setSessionCookie } from "./auth.js";
import type { AppConfig } from "./config.js";
import { createTranscriptionStore } from "./postgres-store.js";
import { ProviderError } from "./runpod.js";
import { registerTranscriptionRoutes } from "./transcription-routes.js";
import { StoreError, type TranscriptionStore } from "./transcriptions.js";
import type { OperationState, PodProvider } from "./types.js";
import { registerWorkerRoutes } from "./worker-routes.js";
import { createWorkerScheduler, type WorkerScheduler } from "./worker-scheduler.js";

const loginSchema = z.object({ password: z.string().min(1).max(256) });

export function createApp(
  config: AppConfig,
  provider: PodProvider,
  options: { serveStatic?: boolean; now?: () => number; store?: TranscriptionStore; scheduler?: WorkerScheduler } = {},
) {
  const app = express();
  const now = options.now ?? Date.now;
  const store = options.store ?? createTranscriptionStore(config);
  const scheduler = options.scheduler ?? createWorkerScheduler(config, provider, { now });
  let operation: OperationState | null = null;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((request, response, next) => {
    const requestId = request.get("x-request-id") || randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "same-origin");
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.use(cookieParser());

  app.get("/api/health", async (_request, response) => {
    const [storage, workerPool] = await Promise.all([store.health(), scheduler.health()]);
    const ready = storage.ready && workerPool.ready;
    response.status(ready ? 200 : 503).json({
      status: ready ? "healthy" : "degraded",
      service: "qwen-railway-control",
      provider: config.provider,
      storage: { kind: store.kind, ready: storage.ready },
      worker_pool: { ready: workerPool.ready },
      timestamp: new Date(now()).toISOString(),
    });
  });

  app.post("/api/session/login", requireAllowedOrigin(config), (request, response, next) => {
    try {
      const body = loginSchema.parse(request.body);
      if (!passwordMatches(body.password, config.controlPassword)) {
        response.status(401).json({
          error: { code: "invalid_credentials", message: "操作パスワードが一致しません", requestId: response.locals.requestId },
        });
        return;
      }
      setSessionCookie(response, config, now());
      response.json({ data: { authenticated: true } });
    } catch (error) {
      next(error);
    }
  });

  const authenticated = requireAuth(config, now);
  app.get("/api/session", authenticated, (_request, response) => response.json({ data: { authenticated: true } }));
  app.post("/api/session/logout", authenticated, requireAllowedOrigin(config), (_request, response) => {
    clearSessionCookie(response, config);
    response.json({ data: { authenticated: false } });
  });
  app.get("/api/models", authenticated, (_request, response) => {
    response.json({
      data: {
        items: listAsrModels(),
        default_model_id: DEFAULT_ASR_MODEL_ID,
      },
    });
  });
  registerTranscriptionRoutes(app, config, store, authenticated, requireAllowedOrigin(config), now, scheduler);
  registerWorkerRoutes(app, store, scheduler, authenticated, requireAllowedOrigin(config), now);

  app.get("/api/control/status", authenticated, async (_request, response, next) => {
    try {
      const pool = await scheduler.diagnostics();
      if (!config.legacyWorkerMode) {
        const selected = pool.workers.find((worker) => worker.status === "ready") || pool.workers[0];
        const stage = pool.summary.ready > 0
          ? "ready"
          : pool.workers.some((worker) => worker.status === "starting" || worker.status === "loading")
            ? "starting"
            : pool.workers.every((worker) => worker.status === "stopped") ? "stopped" : "error";
        response.json({
          data: {
            stage,
            control: { mode: config.provider, available: config.provider !== "readonly" },
            pod: selected ? {
              id: selected.pod_id,
              name: selected.name,
              desiredStatus: selected.status === "stopped" ? "EXITED" : selected.status === "terminated" ? "TERMINATED" : "RUNNING",
              gpu: selected.gpu,
            } : null,
            service: selected ? {
              ready: selected.status === "ready",
              health: selected.health,
            } : { ready: false },
            pool,
            operation: null,
            checkedAt: new Date(now()).toISOString(),
          },
        });
        return;
      }
      let stage: "stopped" | "starting" | "ready" | "stopping" | "error";
      let probe = null;
      let pod;
      if (config.provider === "readonly") {
        probe = await provider.probeService();
        pod = {
          id: config.podId,
          name: config.workers[0]?.name ?? "configured Qwen worker",
          desiredStatus: probe.ready ? "RUNNING" as const : "EXITED" as const,
          gpu: { id: "A100-80GB", displayName: "NVIDIA A100 80GB", count: 1 },
        };
        stage = probe.ready ? "ready" : "stopped";
        operation = null;
      } else {
        pod = await provider.getPod();
        if (pod.desiredStatus === "TERMINATED") {
          stage = "error";
        } else if (operation?.kind === "stop" && pod.desiredStatus !== "EXITED") {
          stage = "stopping";
        } else if (pod.desiredStatus === "EXITED") {
          stage = operation?.kind === "start" ? "starting" : "stopped";
          if (stage === "stopped") operation = null;
        } else {
          probe = await provider.probeService();
          stage = probe.ready ? "ready" : "starting";
          if (stage === "ready") operation = null;
        }
      }
      const websocketUrl = `${config.serviceUrl.replace(/^http/, "ws")}/v1/realtime`;
      response.json({
        data: {
          stage,
          control: { mode: config.provider, available: config.provider !== "readonly" },
          pod: { id: pod.id, name: pod.name, desiredStatus: pod.desiredStatus, costPerHr: pod.costPerHr, gpu: pod.gpu },
          service: {
            url: config.serviceUrl,
            websocketUrl,
            ready: probe?.ready ?? false,
            health: probe?.health,
            message: probe?.message,
          },
          operation,
          pool,
          checkedAt: new Date(now()).toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/control/start", authenticated, requireAllowedOrigin(config), async (_request, response, next) => {
    try {
      if (config.provider === "readonly") {
        throw new ProviderError("runpod_control_unavailable", "RunPod管理者のAPIキーが必要です。現在は文字起こし接続のみ利用できます", 503);
      }
      if (!config.legacyWorkerMode || config.workers.length !== 1) {
        throw new ProviderError("worker_target_required", "複数GPU構成では割り当てAPIから対象ワーカーを起動してください", 409);
      }
      const pod = await provider.getPod();
      if (pod.desiredStatus !== "RUNNING") await provider.startPod();
      operation = operation?.kind === "start" ? operation : { id: randomUUID(), kind: "start", requestedAt: new Date(now()).toISOString() };
      response.status(202).json({ data: { operationId: operation.id, stage: "starting" } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/control/stop", authenticated, requireAllowedOrigin(config), async (_request, response, next) => {
    try {
      if (config.provider === "readonly") {
        throw new ProviderError("runpod_control_unavailable", "RunPod管理者のAPIキーが必要です。現在は文字起こし接続のみ利用できます", 503);
      }
      if (!config.legacyWorkerMode || config.workers.length !== 1) {
        throw new ProviderError("worker_target_required", "複数GPU構成では対象ワーカーを指定して停止してください", 409);
      }
      const pod = await provider.getPod();
      if (pod.desiredStatus !== "EXITED") {
        if (config.provider === "live") await scheduler.stopWorker(config.workers[0].id);
        else await provider.stopPod();
      }
      operation = operation?.kind === "stop" ? operation : { id: randomUUID(), kind: "stop", requestedAt: new Date(now()).toISOString() };
      response.status(202).json({ data: { operationId: operation.id, stage: "stopping" } });
    } catch (error) {
      next(error);
    }
  });

  if (options.serveStatic !== false) {
    const clientDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
    if (existsSync(clientDirectory)) {
      app.use(express.static(clientDirectory, { maxAge: config.nodeEnv === "production" ? "1h" : 0 }));
      app.get(/.*/, (_request, response) => response.sendFile(join(clientDirectory, "index.html")));
    }
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    const requestId = response.locals.requestId;
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: { code: "validation_failed", message: "入力内容を確認してください", requestId, details: error.flatten() },
      });
      return;
    }
    if (error instanceof ProviderError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, requestId } });
      return;
    }
    if (error instanceof StoreError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, requestId } });
      return;
    }
    console.error(JSON.stringify({ level: "error", requestId, message: error instanceof Error ? error.message : "unknown error" }));
    response.status(500).json({ error: { code: "internal_error", message: "制御サービスでエラーが発生しました", requestId } });
  });

  return app;
}
