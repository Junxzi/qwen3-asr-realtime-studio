import { describe, expect, it } from "vitest";
import {
  createAutomaticTitle,
  decodeCursor,
  encodeCursor,
  MemoryTranscriptionStore,
  representativeSpeaker,
  runRetentionMaintenance,
} from "../../server/transcriptions.js";
import type { AppConfig } from "../../server/config.js";

const maintenanceConfig = { transcriptStaleMinutes: 10 } as AppConfig;

describe("transcription history helpers", () => {
  it("creates a compact automatic title", () => {
    expect(createAutomaticTitle("  あかつき証券   の佐藤です。 ")).toBe("あかつき証券 の佐藤です。");
    expect(createAutomaticTitle("あ".repeat(30))).toBe(`${"あ".repeat(24)}…`);
  });

  it("chooses the speaker with the longest aligned duration", () => {
    expect(representativeSpeaker([
      { text: "a", start_ms: 0, end_ms: 100, speaker: "speaker_1" },
      { text: "b", start_ms: 100, end_ms: 800, speaker: "speaker_2" },
    ])).toBe("speaker_2");
  });

  it("round trips a pagination cursor", () => {
    const cursor = encodeCursor({ started_at: "2026-07-16T00:00:00.000Z", id: "session-1" });
    expect(decodeCursor(cursor)).toEqual({ startedAt: "2026-07-16T00:00:00.000Z", id: "session-1" });
    expect(decodeCursor("invalid")).toBeNull();
  });

  it("marks abandoned recording sessions as interrupted", async () => {
    const store = new MemoryTranscriptionStore();
    const started = new Date("2026-07-16T00:00:00.000Z");
    const created = await store.create({
      id: "00000000-0000-4000-8000-000000000001",
      source: "microphone",
      processingMode: "realtime",
      modelId: "context-fullft",
      finalModelId: null,
      catalogRevision: "",
      now: started,
      retentionDays: 30,
    });
    expect(created.status).toBe("recording");
    expect(await store.markStale(new Date("2026-07-16T00:11:00.000Z"), 10)).toBe(1);
    expect((await store.get(created.id, new Date("2026-07-16T00:11:00.000Z")))?.status).toBe("interrupted");
  });

  it("terminalizes stale sessions before releasing their GPU assignments", async () => {
    const store = new MemoryTranscriptionStore();
    const started = new Date("2026-07-16T00:00:00.000Z");
    const now = new Date("2026-07-16T00:11:00.000Z");
    const created = await store.create({
      id: "00000000-0000-4000-8000-000000000002",
      source: "microphone",
      processingMode: "hybrid",
      modelId: "context-fullft",
      finalModelId: "lab-finalizer",
      catalogRevision: "",
      now: started,
      retentionDays: 30,
    });
    const statusesAtRelease: Array<string | undefined> = [];

    const result = await runRetentionMaintenance(store, maintenanceConfig, now, async (sessionId) => {
      statusesAtRelease.push((await store.get(sessionId, now))?.status);
    });

    expect(result).toEqual({ expired: 0, stale: 1 });
    expect(created.id).toBe("00000000-0000-4000-8000-000000000002");
    expect(statusesAtRelease).toEqual(["interrupted"]);
  });

  it("does not interrupt a session that became active after candidate discovery", async () => {
    const started = new Date("2026-07-16T00:00:00.000Z");
    const now = new Date("2026-07-16T00:11:00.000Z");
    class ActivityRaceStore extends MemoryTranscriptionStore {
      override async listMaintenanceCandidates(at: Date, staleMinutes: number) {
        const candidates = await super.listMaintenanceCandidates(at, staleMinutes);
        await this.upsertUtterance("00000000-0000-4000-8000-000000000003", {
          utteranceId: "activity-race",
          revision: 0,
          text: "通話を継続中",
          words: [],
          contextHits: [],
          audioStartMs: 0,
          audioEndMs: 100,
          latencyMs: null,
          queueMs: null,
          rtf: null,
          now: at,
        });
        return candidates;
      }
    }
    const store = new ActivityRaceStore();
    await store.create({
      id: "00000000-0000-4000-8000-000000000003",
      source: "microphone",
      processingMode: "realtime",
      modelId: "context-fullft",
      finalModelId: null,
      catalogRevision: "",
      now: started,
      retentionDays: 30,
    });
    const released: string[] = [];

    const result = await runRetentionMaintenance(store, maintenanceConfig, now, async (sessionId) => {
      released.push(sessionId);
    });

    expect(result).toEqual({ expired: 0, stale: 0 });
    expect(released).toEqual([]);
    expect((await store.get("00000000-0000-4000-8000-000000000003", now))?.status).toBe("recording");
  });

  it("counts expired recordings only as expired", async () => {
    const store = new MemoryTranscriptionStore();
    const started = new Date("2026-07-16T00:00:00.000Z");
    const now = new Date("2026-07-16T00:11:00.000Z");
    await store.create({
      id: "00000000-0000-4000-8000-000000000004",
      source: "microphone",
      processingMode: "realtime",
      modelId: "context-fullft",
      finalModelId: null,
      catalogRevision: "",
      now: started,
      retentionDays: 0,
    });

    await expect(runRetentionMaintenance(store, maintenanceConfig, now)).resolves.toEqual({
      expired: 1,
      stale: 0,
    });
  });
});
