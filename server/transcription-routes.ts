import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isSupportedAsrModel } from "./asr-models.js";
import type { AppConfig } from "./config.js";
import {
  findProcessingProfile,
  inferProcessingMode,
} from "./processing-modes.js";
import type { TranscriptionStore } from "./transcriptions.js";
import type { WorkerScheduler } from "./worker-scheduler.js";

const sourceSchema = z.enum(["microphone", "file"]);
const wordSchema = z.object({
  text: z.string().max(240),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  speaker: z.string().min(1).max(80),
  confidence: z.number().min(0).max(1).optional(),
  overlap: z.boolean().optional(),
}).refine((word) => word.end_ms >= word.start_ms, { message: "end_ms must be after start_ms" });
const metricValue = z.number().finite().nullable().optional();
const metricsSchema = z.object({
  ttft_ms: metricValue,
  stable_latency_p95_ms: metricValue,
  queue_p95_ms: metricValue,
  rewrite_rate: metricValue,
  rtf: metricValue,
  context_hits: metricValue,
}).strict();
const listSchema = z.object({
  cursor: z.string().max(600).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().max(100).optional(),
});
const createSchema = z.object({
  source: sourceSchema,
  processing_mode: z.enum(["realtime", "batch", "hybrid"]).optional(),
  model_id: z.string().min(1).max(240).optional()
    .refine((modelId) => modelId === undefined || isSupportedAsrModel(modelId), {
      message: "選択できないASRモデルです",
    }),
  final_model_id: z.string().min(1).max(240).nullable().optional(),
  catalog_revision: z.string().max(240).default(""),
}).transform((body, context) => {
  const processingMode = body.processing_mode ?? inferProcessingMode(body.model_id);
  const profile = findProcessingProfile(processingMode);
  if (!profile) {
    context.addIssue({ code: "custom", path: ["processing_mode"], message: "選択できない処理方式です" });
    return z.NEVER;
  }
  if (!profile.input_modes.includes(body.source)) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: `${processingMode}は${profile.input_modes.join("/")}入力だけに対応しています`,
    });
  }
  if (body.model_id && body.model_id !== profile.primary_model_id) {
    context.addIssue({
      code: "custom",
      path: ["model_id"],
      message: "処理方式とASRモデルの組み合わせが一致しません",
    });
  }
  if (body.final_model_id !== undefined && body.final_model_id !== profile.final_model_id) {
    context.addIssue({
      code: "custom",
      path: ["final_model_id"],
      message: "処理方式と最終再推論モデルの組み合わせが一致しません",
    });
  }
  return {
    source: body.source,
    processing_mode: processingMode,
    model_id: profile.primary_model_id,
    final_model_id: profile.final_model_id,
    catalog_revision: body.catalog_revision,
  };
});
const renameSchema = z.object({ title: z.string().trim().min(1).max(160) });
const utteranceSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  text: z.string().trim().min(1).max(20_000),
  words: z.array(wordSchema).max(5000).default([]),
  context_hits: z.array(z.string().min(1).max(240)).max(100).default([]),
  audio_start_ms: z.number().int().nonnegative().default(0),
  audio_end_ms: z.number().int().nonnegative().default(0),
  latency_ms: z.number().finite().nonnegative().nullable().default(null),
  queue_ms: z.number().finite().nonnegative().nullable().default(null),
  rtf: z.number().finite().nonnegative().nullable().default(null),
}).refine((utterance) => utterance.audio_end_ms >= utterance.audio_start_ms, {
  path: ["audio_end_ms"],
  message: "audio_end_ms must be after audio_start_ms",
});
const completeSchema = z.object({
  status: z.enum(["completed", "interrupted", "failed"]),
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  metrics: metricsSchema.default({}),
});
const idSchema = z.string().uuid();
const utteranceIdSchema = z.string().min(1).max(160);

export function registerTranscriptionRoutes(
  app: Express,
  config: AppConfig,
  store: TranscriptionStore,
  authenticated: RequestHandler,
  allowedOrigin: RequestHandler,
  now: () => number,
  scheduler?: WorkerScheduler,
) {
  app.get("/api/transcriptions", authenticated, async (request, response, next) => {
    try {
      const query = listSchema.parse(request.query);
      const result = await store.list({
        limit: query.limit,
        cursor: query.cursor,
        query: query.q,
        now: new Date(now()),
      });
      response.json({
        data: result.items,
        meta: {
          totalCount: result.totalCount,
          pageSize: query.limit,
          nextCursor: result.nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/transcriptions", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const body = createSchema.parse(request.body);
      const session = await store.create({
        id: randomUUID(),
        source: body.source,
        processingMode: body.processing_mode,
        modelId: body.model_id,
        finalModelId: body.final_model_id,
        catalogRevision: body.catalog_revision,
        now: new Date(now()),
        retentionDays: config.transcriptRetentionDays,
      });
      response.status(201).json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/transcriptions/:id", authenticated, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const session = await store.get(id, new Date(now()));
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      response.json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/transcriptions/:id", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const body = renameSchema.parse(request.body);
      const session = await store.rename(id, body.title, new Date(now()));
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      response.json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/transcriptions/:id/utterances/:utteranceId", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const sessionId = idSchema.parse(request.params.id);
      const utteranceId = utteranceIdSchema.parse(request.params.utteranceId);
      const body = utteranceSchema.parse(request.body);
      const utterance = await store.upsertUtterance(sessionId, {
        utteranceId,
        revision: body.revision,
        text: body.text,
        words: body.words,
        contextHits: body.context_hits,
        audioStartMs: body.audio_start_ms,
        audioEndMs: body.audio_end_ms,
        latencyMs: body.latency_ms,
        queueMs: body.queue_ms,
        rtf: body.rtf,
        now: new Date(now()),
      });
      if (!utterance) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "保存先の文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      await scheduler?.touch(sessionId);
      response.json({ data: utterance });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/transcriptions/:id/complete", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const body = completeSchema.parse(request.body);
      const session = await store.complete(id, {
        status: body.status,
        durationMs: body.duration_ms,
        metrics: body.metrics,
        now: new Date(now()),
      });
      if (!session) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      await scheduler?.release(id);
      response.json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/transcriptions/:id", authenticated, allowedOrigin, async (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      const terminal = await store.complete(id, {
        status: "interrupted",
        durationMs: null,
        metrics: {},
        now: new Date(now()),
      });
      if (!terminal) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      await scheduler?.release(id);
      const deleted = await store.delete(id);
      if (!deleted) {
        response.status(404).json({
          error: { code: "transcription_not_found", message: "文字起こし履歴が見つかりません", requestId: response.locals.requestId },
        });
        return;
      }
      response.json({ data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  });
}
