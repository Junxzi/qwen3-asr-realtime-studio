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
