import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { listAsrModels } from "./asr-models.js";
import type { TranscriptionStore } from "./transcriptions.js";
import type { WorkerScheduler } from "./worker-scheduler.js";

const idSchema = z.string().uuid();
const assignmentSchema = z.object({ purpose: z.enum(["realtime", "batch"]) }).strict();

function assignmentStatusCode(status: string) {
  return status === "requested" || status === "provisioning" ? 202 : 200;
}

export function registerWorkerRoutes(
  app: Express,
  store: TranscriptionStore,
  scheduler: WorkerScheduler,
  authenticated: RequestHandler,
  allowedOrigin: RequestHandler,
  now: () => number,
) {
  app.get("/api/workers", authenticated, async (_request, response, next) => {
    try {
      await scheduler.reconcile();
      response.json({ data: await scheduler.diagnostics() });
    } catch (error) { next(error); }
  });

  app.post("/api/transcriptions/:id/assignment", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const body = assignmentSchema.parse(request.body);
      const session = await store.get(id, new Date(now()));
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      if (session.status !== "recording") {
        response.status(409).json({
          error: {
            code: "transcription_not_active",
            message: "完了済みの文字起こしにはGPUを割り当てられません",
            requestId: response.locals.requestId,
          },
        });
        return;
      }
      const model = listAsrModels().find((candidate) => candidate.id === session.model_id);
      if (!model || model.runtime !== body.purpose) {
        response.status(409).json({
          error: {
            code: "assignment_purpose_mismatch",
            message: "選択モデルと処理方式が一致しません",
            requestId: response.locals.requestId,
          },
        });
        return;
      }
      const assignment = await scheduler.request({ sessionId: id, modelId: session.model_id, purpose: body.purpose });
      const payload = await scheduler.response(assignment);
      if (payload.connection?.catalog_revision && payload.connection.catalog_revision !== session.catalog_revision) {
        await store.setCatalogRevision(id, payload.connection.catalog_revision, new Date(now()));
      }
      response.setHeader("cache-control", "no-store");
      response.status(assignmentStatusCode(assignment.status)).json({ data: payload });
    } catch (error) { next(error); }
  });

  app.get("/api/transcriptions/:id/assignment", authenticated, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const session = await store.get(id, new Date(now()));
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      const assignment = await scheduler.observe(id);
      if (!assignment) {
        response.status(404).json({
          error: { code: "assignment_not_found", message: "この文字起こしのワーカー割当はまだありません", requestId: response.locals.requestId },
        });
        return;
      }
      response.setHeader("cache-control", "no-store");
      response.status(assignmentStatusCode(assignment.status)).json({ data: await scheduler.response(assignment) });
    } catch (error) { next(error); }
  });

  app.post(
    "/api/transcriptions/:id/assignment/heartbeat",
    authenticated,
    allowedOrigin,
    async (request, response, next) => {
      try {
        const id = idSchema.parse(request.params.id);
        const session = await store.get(id, new Date(now()));
        if (!session) {
          response.status(404).json({
            error: {
              code: "transcription_not_found",
              message: "文字起こしセッションが見つかりません",
              requestId: response.locals.requestId,
            },
          });
          return;
        }
        if (session.status !== "recording") {
          response.status(409).json({
            error: {
              code: "transcription_not_active",
              message: "完了済みの文字起こしはGPU割り当てを延長できません",
              requestId: response.locals.requestId,
            },
          });
          return;
        }
        const assignment = await scheduler.touch(id);
        if (!assignment) {
          response.status(404).json({
            error: {
              code: "assignment_not_found",
              message: "GPUワーカーの割り当てが見つかりません",
              requestId: response.locals.requestId,
            },
          });
          return;
        }
        if (assignment.status !== "active") {
          response.status(409).json({
            error: {
              code: "assignment_not_active",
              message: "準備済みまたは処理中のGPU割り当てだけを延長できます",
              requestId: response.locals.requestId,
            },
          });
          return;
        }
        response.setHeader("cache-control", "no-store");
        response.json({
          data: {
            status: assignment.status,
            lease_expires_at: assignment.leaseExpiresAt.toISOString(),
          },
        });
      } catch (error) { next(error); }
    },
  );
}
