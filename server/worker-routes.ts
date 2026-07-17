import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { assignmentForPurpose } from "./processing-modes.js";
import type { TranscriptionStore } from "./transcriptions.js";
import type { WorkerScheduler } from "./worker-scheduler.js";

const idSchema = z.string().uuid();
const assignmentSchema = z.object({ purpose: z.enum(["realtime", "batch"]) }).strict();
const assignmentQuerySchema = z.object({ purpose: z.enum(["realtime", "batch"]).optional() });
const heartbeatSchema = z.object({ purpose: z.enum(["realtime", "batch"]).optional() }).strict();

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
      const target = assignmentForPurpose(session.processing_mode, body.purpose);
      const storedModelId = body.purpose === "realtime"
        ? session.model_id
        : session.processing_mode === "batch" ? session.model_id : session.final_model_id;
      if (!target || !storedModelId || target.model_id !== storedModelId) {
        response.status(409).json({
          error: {
            code: "assignment_purpose_mismatch",
            message: "選択モデルと処理方式が一致しません",
            requestId: response.locals.requestId,
          },
        });
        return;
      }
      const assignment = await scheduler.request({ sessionId: id, modelId: target.model_id, purpose: body.purpose });
      const payload = await scheduler.response(assignment);
      if (
        body.purpose === "realtime"
        && payload.connection?.catalog_revision
        && payload.connection.catalog_revision !== session.catalog_revision
      ) {
        await store.setCatalogRevision(id, payload.connection.catalog_revision, new Date(now()));
      }
      response.setHeader("cache-control", "no-store");
      response.status(assignmentStatusCode(assignment.status)).json({ data: payload });
    } catch (error) { next(error); }
  });

  app.get("/api/transcriptions/:id/assignment", authenticated, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const query = assignmentQuerySchema.parse(request.query);
      const session = await store.get(id, new Date(now()));
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      const assignment = await scheduler.observe(id, query.purpose);
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
        const body = heartbeatSchema.parse(request.body ?? {});
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
        const assignments = await scheduler.touch(id, body.purpose);
        if (!assignments.length) {
          response.status(404).json({
            error: {
              code: "assignment_not_found",
              message: "GPUワーカーの割り当てが見つかりません",
              requestId: response.locals.requestId,
            },
          });
          return;
        }
        if (assignments.some((assignment) => assignment.status !== "active")) {
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
        const leaseExpiresAt = new Date(Math.min(...assignments.map((assignment) => assignment.leaseExpiresAt.getTime())));
        response.json({
          data: {
            status: "active",
            lease_expires_at: leaseExpiresAt.toISOString(),
            assignments: assignments.map((assignment) => ({
              purpose: assignment.purpose,
              status: assignment.status,
              lease_expires_at: assignment.leaseExpiresAt.toISOString(),
            })),
          },
        });
      } catch (error) { next(error); }
    },
  );
}
