import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { transcriptUtterances, transcriptionSessions } from "./schema.js";
import {
  createAutomaticTitle,
  createDefaultTitle,
  decodeCursor,
  encodeCursor,
  MemoryTranscriptionStore,
  representativeSpeaker,
  StoreError,
  type CompleteTranscriptionInput,
  type CreateTranscriptionInput,
  type ListResult,
  type TranscriptUtterance,
  type TranscriptionDetail,
  type TranscriptionMetrics,
  type TranscriptionSession,
  type TranscriptionStore,
  type UpsertUtteranceInput,
} from "./transcriptions.js";

type SessionRow = typeof transcriptionSessions.$inferSelect;
type UtteranceRow = typeof transcriptUtterances.$inferSelect;

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function mapSession(row: SessionRow, utteranceCount = 0): TranscriptionSession {
  return {
    id: row.id,
    title: row.title,
    title_customized: row.titleCustomized,
    status: row.status as TranscriptionSession["status"],
    source: row.source as TranscriptionSession["source"],
    model_id: row.modelId,
    catalog_revision: row.catalogRevision,
    started_at: row.startedAt.toISOString(),
    ended_at: toIso(row.endedAt),
    last_activity_at: row.lastActivityAt.toISOString(),
    duration_ms: row.durationMs,
    metrics: row.metrics as TranscriptionMetrics,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    utterance_count: utteranceCount,
  };
}

function mapUtterance(row: UtteranceRow): TranscriptUtterance {
  return {
    id: row.id,
    session_id: row.sessionId,
    utterance_id: row.utteranceId,
    revision: row.revision,
    sequence: row.sequence,
    speaker: row.speaker,
    text: row.text,
    words: row.words,
    context_hits: row.contextHits,
    audio_end_ms: row.audioEndMs,
    latency_ms: row.latencyMs,
    queue_ms: row.queueMs,
    rtf: row.rtf,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export class PostgresTranscriptionStore implements TranscriptionStore {
  readonly kind = "postgres" as const;
  private pool: Pool;
  private database;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: false },
    });
    this.database = drizzle(this.pool);
  }

  private fail(error: unknown): never {
    if (error instanceof StoreError) throw error;
    const message = error instanceof Error ? error.message : "database unavailable";
    throw new StoreError("database_unavailable", `履歴データベースへ接続できません: ${message}`, 503);
  }

  async health() {
    try {
      await this.database.execute(sql`select 1`);
      return { ready: true };
    } catch (error) {
      return { ready: false, message: error instanceof Error ? error.message : "database unavailable" };
    }
  }

  async list({ limit, cursor, query, now }: { limit: number; cursor?: string; query?: string; now: Date }): Promise<ListResult> {
    try {
      const conditions: SQL[] = [gt(transcriptionSessions.expiresAt, now)];
      if (query?.trim()) conditions.push(ilike(transcriptionSessions.title, `%${query.trim()}%`));
      const decoded = decodeCursor(cursor);
      if (decoded) {
        const cursorDate = new Date(decoded.startedAt);
        if (!Number.isNaN(cursorDate.getTime())) {
          const cursorCondition = or(
            lt(transcriptionSessions.startedAt, cursorDate),
            and(eq(transcriptionSessions.startedAt, cursorDate), lt(transcriptionSessions.id, decoded.id)),
          );
          if (cursorCondition) conditions.push(cursorCondition);
        }
      }
      const where = and(...conditions);
      const rows = await this.database.select()
        .from(transcriptionSessions)
        .where(where)
        .orderBy(desc(transcriptionSessions.startedAt), desc(transcriptionSessions.id))
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const countRows = pageRows.length
        ? await this.database.select({
          sessionId: transcriptUtterances.sessionId,
          value: sql<number>`count(*)::int`,
        }).from(transcriptUtterances)
          .where(inArray(transcriptUtterances.sessionId, pageRows.map((row) => row.id)))
          .groupBy(transcriptUtterances.sessionId)
        : [];
      const countBySession = new Map(countRows.map((row) => [row.sessionId, Number(row.value)]));
      const items = pageRows.map((row) => mapSession(row, countBySession.get(row.id) || 0));

      const totalConditions: SQL[] = [gt(transcriptionSessions.expiresAt, now)];
      if (query?.trim()) totalConditions.push(ilike(transcriptionSessions.title, `%${query.trim()}%`));
      const [total] = await this.database.select({ value: sql<number>`count(*)::int` })
        .from(transcriptionSessions)
        .where(and(...totalConditions));
      return {
        items,
        totalCount: Number(total?.value || 0),
        nextCursor: rows.length > limit && items.length ? encodeCursor(items.at(-1)!) : null,
      };
    } catch (error) {
      this.fail(error);
    }
  }

  async create(input: CreateTranscriptionInput) {
    try {
      const expiresAt = new Date(input.now.getTime() + input.retentionDays * 86_400_000);
      const [created] = await this.database.insert(transcriptionSessions).values({
        id: input.id,
        title: createDefaultTitle(input.now),
        titleCustomized: false,
        status: "recording",
        source: input.source,
        modelId: input.modelId,
        catalogRevision: input.catalogRevision,
        startedAt: input.now,
        endedAt: null,
        lastActivityAt: input.now,
        durationMs: null,
        metrics: {},
        expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning();
      return mapSession(created, 0);
    } catch (error) {
      this.fail(error);
    }
  }

  async get(id: string, now: Date): Promise<TranscriptionDetail | null> {
    try {
      const [session] = await this.database.select()
        .from(transcriptionSessions)
        .where(and(eq(transcriptionSessions.id, id), gt(transcriptionSessions.expiresAt, now)))
        .limit(1);
      if (!session) return null;
      const utterances = await this.database.select()
        .from(transcriptUtterances)
        .where(eq(transcriptUtterances.sessionId, id))
        .orderBy(transcriptUtterances.sequence);
      return { ...mapSession(session, utterances.length), utterances: utterances.map(mapUtterance) };
    } catch (error) {
      this.fail(error);
    }
  }

  async rename(id: string, title: string, now: Date) {
    try {
      const [updated] = await this.database.update(transcriptionSessions)
        .set({ title, titleCustomized: true, updatedAt: now })
        .where(eq(transcriptionSessions.id, id))
        .returning();
      if (!updated) return null;
      const [countRow] = await this.database.select({ value: sql<number>`count(*)::int` })
        .from(transcriptUtterances)
        .where(eq(transcriptUtterances.sessionId, id));
      return mapSession(updated, Number(countRow?.value || 0));
    } catch (error) {
      this.fail(error);
    }
  }

  async upsertUtterance(sessionId: string, input: UpsertUtteranceInput) {
    try {
      return await this.database.transaction(async (transaction) => {
        const [session] = await transaction.select()
          .from(transcriptionSessions)
          .where(and(eq(transcriptionSessions.id, sessionId), gt(transcriptionSessions.expiresAt, input.now)))
          .limit(1);
        if (!session) return null;
        const [existing] = await transaction.select()
          .from(transcriptUtterances)
          .where(and(
            eq(transcriptUtterances.sessionId, sessionId),
            eq(transcriptUtterances.utteranceId, input.utteranceId),
          ))
          .limit(1);
        const values = {
          revision: input.revision,
          speaker: representativeSpeaker(input.words),
          text: input.text,
          words: input.words,
          contextHits: input.contextHits,
          audioEndMs: input.audioEndMs,
          latencyMs: input.latencyMs,
          queueMs: input.queueMs,
          rtf: input.rtf,
          updatedAt: input.now,
        };
        let saved: UtteranceRow;
        if (existing) {
          [saved] = await transaction.update(transcriptUtterances)
            .set(values)
            .where(eq(transcriptUtterances.id, existing.id))
            .returning();
        } else {
          const [maximum] = await transaction.select({
            value: sql<number>`coalesce(max(${transcriptUtterances.sequence}), 0)::int`,
          }).from(transcriptUtterances)
            .where(eq(transcriptUtterances.sessionId, sessionId));
          [saved] = await transaction.insert(transcriptUtterances).values({
            id: randomUUID(),
            sessionId,
            utteranceId: input.utteranceId,
            sequence: Number(maximum?.value || 0) + 1,
            createdAt: input.now,
            ...values,
          }).returning();
          if (!session.titleCustomized && Number(maximum?.value || 0) === 0) {
            await transaction.update(transcriptionSessions)
              .set({ title: createAutomaticTitle(input.text) })
              .where(eq(transcriptionSessions.id, sessionId));
          }
        }
        await transaction.update(transcriptionSessions)
          .set({ lastActivityAt: input.now, updatedAt: input.now })
          .where(eq(transcriptionSessions.id, sessionId));
        return mapUtterance(saved);
      });
    } catch (error) {
      this.fail(error);
    }
  }

  async complete(id: string, input: CompleteTranscriptionInput) {
    try {
      const [updated] = await this.database.update(transcriptionSessions)
        .set({
          status: input.status,
          endedAt: input.now,
          lastActivityAt: input.now,
          durationMs: input.durationMs,
          metrics: input.metrics,
          updatedAt: input.now,
        })
        .where(eq(transcriptionSessions.id, id))
        .returning();
      if (!updated) return null;
      const [countRow] = await this.database.select({ value: sql<number>`count(*)::int` })
        .from(transcriptUtterances)
        .where(eq(transcriptUtterances.sessionId, id));
      return mapSession(updated, Number(countRow?.value || 0));
    } catch (error) {
      this.fail(error);
    }
  }

  async delete(id: string) {
    try {
      const deleted = await this.database.delete(transcriptionSessions)
        .where(eq(transcriptionSessions.id, id))
        .returning({ id: transcriptionSessions.id });
      return deleted.length > 0;
    } catch (error) {
      this.fail(error);
    }
  }

  async deleteExpired(now: Date) {
    try {
      const deleted = await this.database.delete(transcriptionSessions)
        .where(lt(transcriptionSessions.expiresAt, now))
        .returning({ id: transcriptionSessions.id });
      return deleted.length;
    } catch (error) {
      this.fail(error);
    }
  }

  async markStale(now: Date, staleMinutes: number) {
    try {
      const threshold = new Date(now.getTime() - staleMinutes * 60_000);
      const updated = await this.database.update(transcriptionSessions)
        .set({ status: "interrupted", endedAt: now, updatedAt: now })
        .where(and(
          eq(transcriptionSessions.status, "recording"),
          lt(transcriptionSessions.lastActivityAt, threshold),
        ))
        .returning({ id: transcriptionSessions.id });
      return updated.length;
    } catch (error) {
      this.fail(error);
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createTranscriptionStore(config: AppConfig): TranscriptionStore {
  if (config.transcriptStorage === "postgres") return new PostgresTranscriptionStore(config.databaseUrl);
  return new MemoryTranscriptionStore();
}
