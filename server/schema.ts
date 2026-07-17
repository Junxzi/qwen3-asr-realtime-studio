import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StoredWord, TranscriptionMetrics } from "./transcriptions.js";

export const transcriptionSessions = pgTable("transcription_sessions", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 160 }).notNull(),
  titleCustomized: boolean("title_customized").notNull().default(false),
  status: varchar("status", { length: 24 }).notNull(),
  source: varchar("source", { length: 20 }).notNull(),
  modelId: varchar("model_id", { length: 240 }).notNull(),
  catalogRevision: varchar("catalog_revision", { length: 240 }).notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms"),
  metrics: jsonb("metrics").$type<TranscriptionMetrics>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("transcription_sessions_started_idx").on(table.startedAt),
  index("transcription_sessions_expires_idx").on(table.expiresAt),
  index("transcription_sessions_title_idx").on(table.title),
]);

export const transcriptUtterances = pgTable("transcript_utterances", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => transcriptionSessions.id, { onDelete: "cascade" }),
  utteranceId: varchar("utterance_id", { length: 160 }).notNull(),
  revision: integer("revision").notNull().default(0),
  sequence: integer("sequence").notNull(),
  speaker: varchar("speaker", { length: 80 }).notNull(),
  text: text("text").notNull(),
  words: jsonb("words").$type<StoredWord[]>().notNull().default([]),
  contextHits: jsonb("context_hits").$type<string[]>().notNull().default([]),
  audioEndMs: integer("audio_end_ms").notNull().default(0),
  latencyMs: doublePrecision("latency_ms"),
  queueMs: doublePrecision("queue_ms"),
  rtf: doublePrecision("rtf"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("transcript_utterances_session_utterance_idx").on(table.sessionId, table.utteranceId),
  uniqueIndex("transcript_utterances_session_sequence_idx").on(table.sessionId, table.sequence),
]);

export const inferenceWorkers = pgTable("inference_workers", {
  id: varchar("id", { length: 160 }).primaryKey(),
  podId: varchar("pod_id", { length: 160 }).notNull().default(""),
  name: varchar("name", { length: 200 }).notNull(),
  serviceUrl: text("service_url").notNull(),
  modelId: varchar("model_id", { length: 240 }).notNull(),
  runtime: varchar("runtime", { length: 20 }).notNull(),
  origin: varchar("origin", { length: 20 }).notNull().default("static"),
  status: varchar("status", { length: 24 }).notNull(),
  maxSessions: integer("max_sessions").notNull(),
  activeSessions: integer("active_sessions").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  gpu: jsonb("gpu").$type<Record<string, unknown> | null>(),
  health: jsonb("health").$type<Record<string, unknown> | null>(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("inference_workers_scheduler_idx").on(table.enabled, table.status, table.modelId, table.runtime),
  uniqueIndex("inference_workers_pod_id_unique_idx").on(table.podId).where(sql`${table.podId} <> ''`),
]);

export const transcriptionAssignments = pgTable("transcription_assignments", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => transcriptionSessions.id, { onDelete: "cascade" }),
  workerId: varchar("worker_id", { length: 160 }).references(() => inferenceWorkers.id, { onDelete: "set null" }),
  modelId: varchar("model_id", { length: 240 }).notNull(),
  purpose: varchar("purpose", { length: 20 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  message: text("message"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("transcription_assignments_session_idx").on(table.sessionId),
  index("transcription_assignments_worker_status_idx").on(table.workerId, table.status),
  index("transcription_assignments_lease_idx").on(table.leaseExpiresAt),
]);
