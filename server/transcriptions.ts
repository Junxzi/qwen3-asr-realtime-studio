import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";

export type TranscriptSource = "microphone" | "file";
export type TranscriptionStatus = "recording" | "completed" | "interrupted" | "failed";

export interface StoredWord {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string;
  confidence?: number;
  overlap?: boolean;
}

export interface TranscriptionMetrics {
  ttft_ms?: number | null;
  stable_latency_p95_ms?: number | null;
  queue_p95_ms?: number | null;
  rewrite_rate?: number | null;
  rtf?: number | null;
  context_hits?: number | null;
}

export interface TranscriptionSession {
  id: string;
  title: string;
  title_customized: boolean;
  status: TranscriptionStatus;
  source: TranscriptSource;
  model_id: string;
  catalog_revision: string;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  duration_ms: number | null;
  metrics: TranscriptionMetrics;
  expires_at: string;
  created_at: string;
  updated_at: string;
  utterance_count: number;
}

export interface TranscriptUtterance {
  id: string;
  session_id: string;
  utterance_id: string;
  revision: number;
  sequence: number;
  speaker: string;
  text: string;
  words: StoredWord[];
  context_hits: string[];
  audio_end_ms: number;
  latency_ms: number | null;
  queue_ms: number | null;
  rtf: number | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptionDetail extends TranscriptionSession {
  utterances: TranscriptUtterance[];
}

export interface ListResult {
  items: TranscriptionSession[];
  totalCount: number;
  nextCursor: string | null;
}

export interface CreateTranscriptionInput {
  id: string;
  source: TranscriptSource;
  modelId: string;
  catalogRevision: string;
  now: Date;
  retentionDays: number;
}

export interface UpsertUtteranceInput {
  utteranceId: string;
  revision: number;
  text: string;
  words: StoredWord[];
  contextHits: string[];
  audioEndMs: number;
  latencyMs: number | null;
  queueMs: number | null;
  rtf: number | null;
  now: Date;
}

export interface CompleteTranscriptionInput {
  status: Exclude<TranscriptionStatus, "recording">;
  durationMs: number | null;
  metrics: TranscriptionMetrics;
  now: Date;
}

export interface TranscriptionStore {
  readonly kind: "memory" | "postgres";
  health(): Promise<{ ready: boolean; message?: string }>;
  list(input: { limit: number; cursor?: string; query?: string; now: Date }): Promise<ListResult>;
  create(input: CreateTranscriptionInput): Promise<TranscriptionSession>;
  get(id: string, now: Date): Promise<TranscriptionDetail | null>;
  rename(id: string, title: string, now: Date): Promise<TranscriptionSession | null>;
  setCatalogRevision(id: string, catalogRevision: string, now: Date): Promise<TranscriptionSession | null>;
  upsertUtterance(sessionId: string, input: UpsertUtteranceInput): Promise<TranscriptUtterance | null>;
  complete(id: string, input: CompleteTranscriptionInput): Promise<TranscriptionSession | null>;
  delete(id: string): Promise<boolean>;
  listMaintenanceCandidates(now: Date, staleMinutes: number): Promise<string[]>;
  deleteExpired(now: Date): Promise<number>;
  markStale(now: Date, staleMinutes: number): Promise<number>;
  close(): Promise<void>;
}

export class StoreError extends Error {
  constructor(public code: string, message: string, public status = 503) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

export function createDefaultTitle(now: Date) {
  return `新しい文字起こし · ${new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(now)}`;
}

export function createAutomaticTitle(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "新しい文字起こし";
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
}

export function representativeSpeaker(words: StoredWord[]) {
  const counts = new Map<string, number>();
  for (const word of words) {
    const speaker = word.speaker || "speaker_unknown";
    counts.set(speaker, (counts.get(speaker) || 0) + Math.max(1, word.end_ms - word.start_ms));
  }
  let selected = "speaker_unknown";
  let maximum = -1;
  for (const [speaker, count] of counts) {
    if (count > maximum) {
      selected = speaker;
      maximum = count;
    }
  }
  return selected;
}

export function encodeCursor(session: Pick<TranscriptionSession, "started_at" | "id">) {
  return Buffer.from(JSON.stringify([session.started_at, session.id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    return { startedAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

function cloneSession(session: TranscriptionSession): TranscriptionSession {
  return { ...session, metrics: { ...session.metrics } };
}

function cloneUtterance(utterance: TranscriptUtterance): TranscriptUtterance {
  return {
    ...utterance,
    words: utterance.words.map((word) => ({ ...word })),
    context_hits: [...utterance.context_hits],
  };
}

export class MemoryTranscriptionStore implements TranscriptionStore {
  readonly kind = "memory" as const;
  private sessions = new Map<string, TranscriptionSession>();
  private utterances = new Map<string, TranscriptUtterance[]>();

  async health() {
    return { ready: true };
  }

  async list({ limit, cursor, query, now }: { limit: number; cursor?: string; query?: string; now: Date }): Promise<ListResult> {
    const decoded = decodeCursor(cursor);
    const normalizedQuery = query?.trim().toLocaleLowerCase("ja-JP");
    const all = [...this.sessions.values()]
      .filter((session) => Date.parse(session.expires_at) > now.getTime())
      .filter((session) => !normalizedQuery || session.title.toLocaleLowerCase("ja-JP").includes(normalizedQuery))
      .sort((left, right) => right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id));
    const filtered = decoded
      ? all.filter((session) => session.started_at < decoded.startedAt || (session.started_at === decoded.startedAt && session.id < decoded.id))
      : all;
    const page = filtered.slice(0, limit);
    return {
      items: page.map(cloneSession),
      totalCount: all.length,
      nextCursor: filtered.length > limit && page.length ? encodeCursor(page.at(-1)!) : null,
    };
  }

  async create(input: CreateTranscriptionInput) {
    const timestamp = input.now.toISOString();
    const session: TranscriptionSession = {
      id: input.id,
      title: createDefaultTitle(input.now),
      title_customized: false,
      status: "recording",
      source: input.source,
      model_id: input.modelId,
      catalog_revision: input.catalogRevision,
      started_at: timestamp,
      ended_at: null,
      last_activity_at: timestamp,
      duration_ms: null,
      metrics: {},
      expires_at: new Date(input.now.getTime() + input.retentionDays * DAY_MS).toISOString(),
      created_at: timestamp,
      updated_at: timestamp,
      utterance_count: 0,
    };
    this.sessions.set(session.id, session);
    this.utterances.set(session.id, []);
    return cloneSession(session);
  }

  async get(id: string, now: Date) {
    const session = this.sessions.get(id);
    if (!session || Date.parse(session.expires_at) <= now.getTime()) return null;
    return {
      ...cloneSession(session),
      utterances: (this.utterances.get(id) || []).map(cloneUtterance).sort((a, b) => a.sequence - b.sequence),
    };
  }

  async rename(id: string, title: string, now: Date) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.title = title;
    session.title_customized = true;
    session.updated_at = now.toISOString();
    return cloneSession(session);
  }

  async setCatalogRevision(id: string, catalogRevision: string, now: Date) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.catalog_revision = catalogRevision;
    session.updated_at = now.toISOString();
    return cloneSession(session);
  }

  async upsertUtterance(sessionId: string, input: UpsertUtteranceInput) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const values = this.utterances.get(sessionId) || [];
    const existing = values.find((utterance) => utterance.utterance_id === input.utteranceId);
    const timestamp = input.now.toISOString();
    if (existing) {
      if (input.revision < existing.revision) return cloneUtterance(existing);
      Object.assign(existing, {
        revision: input.revision,
        speaker: representativeSpeaker(input.words),
        text: input.text,
        words: input.words.map((word) => ({ ...word })),
        context_hits: [...input.contextHits],
        audio_end_ms: input.audioEndMs,
        latency_ms: input.latencyMs,
        queue_ms: input.queueMs,
        rtf: input.rtf,
        updated_at: timestamp,
      });
      session.last_activity_at = timestamp;
      session.updated_at = timestamp;
      return cloneUtterance(existing);
    }
    const utterance: TranscriptUtterance = {
      id: randomUUID(),
      session_id: sessionId,
      utterance_id: input.utteranceId,
      revision: input.revision,
      sequence: values.length + 1,
      speaker: representativeSpeaker(input.words),
      text: input.text,
      words: input.words.map((word) => ({ ...word })),
      context_hits: [...input.contextHits],
      audio_end_ms: input.audioEndMs,
      latency_ms: input.latencyMs,
      queue_ms: input.queueMs,
      rtf: input.rtf,
      created_at: timestamp,
      updated_at: timestamp,
    };
    values.push(utterance);
    this.utterances.set(sessionId, values);
    session.utterance_count = values.length;
    session.last_activity_at = timestamp;
    session.updated_at = timestamp;
    if (!session.title_customized && values.length === 1) session.title = createAutomaticTitle(input.text);
    return cloneUtterance(utterance);
  }

  async complete(id: string, input: CompleteTranscriptionInput) {
    const session = this.sessions.get(id);
    if (!session) return null;
    // Completion can race a late WebSocket close callback. The first terminal
    // transition owns the immutable session outcome; retries remain idempotent.
    if (session.status !== "recording") return cloneSession(session);
    session.status = input.status;
    session.ended_at = input.now.toISOString();
    session.last_activity_at = input.now.toISOString();
    session.updated_at = input.now.toISOString();
    session.duration_ms = input.durationMs;
    session.metrics = { ...input.metrics };
    return cloneSession(session);
  }

  async delete(id: string) {
    const existed = this.sessions.delete(id);
    this.utterances.delete(id);
    return existed;
  }

  async listMaintenanceCandidates(now: Date, staleMinutes: number) {
    const staleThreshold = now.getTime() - staleMinutes * 60_000;
    return [...this.sessions.values()]
      .filter((session) => Date.parse(session.expires_at) < now.getTime()
        || (session.status === "recording" && Date.parse(session.last_activity_at) < staleThreshold))
      .map((session) => session.id);
  }

  async deleteExpired(now: Date) {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expires_at) <= now.getTime()) {
        this.sessions.delete(id);
        this.utterances.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async markStale(now: Date, staleMinutes: number) {
    const threshold = now.getTime() - staleMinutes * 60_000;
    let updated = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "recording" && Date.parse(session.last_activity_at) < threshold) {
        session.status = "interrupted";
        session.ended_at = now.toISOString();
        session.updated_at = now.toISOString();
        updated += 1;
      }
    }
    return updated;
  }

  async close() {}
}

export async function runRetentionMaintenance(
  store: TranscriptionStore,
  config: AppConfig,
  now = new Date(),
  beforeFinalize?: (sessionId: string) => Promise<unknown>,
) {
  if (beforeFinalize) {
    const candidates = await store.listMaintenanceCandidates(now, config.transcriptStaleMinutes);
    await Promise.all(candidates.map((sessionId) => beforeFinalize(sessionId)));
  }
  const [expired, stale] = await Promise.all([
    store.deleteExpired(now),
    store.markStale(now, config.transcriptStaleMinutes),
  ]);
  return { expired, stale };
}
