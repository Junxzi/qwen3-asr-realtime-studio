import { describe, expect, it } from "vitest";
import {
  createAutomaticTitle,
  decodeCursor,
  encodeCursor,
  MemoryTranscriptionStore,
  representativeSpeaker,
} from "../../server/transcriptions.js";

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
      modelId: "context-fullft",
      catalogRevision: "",
      now: started,
      retentionDays: 30,
    });
    expect(created.status).toBe("recording");
    expect(await store.markStale(new Date("2026-07-16T00:11:00.000Z"), 10)).toBe(1);
    expect((await store.get(created.id, new Date("2026-07-16T00:11:00.000Z")))?.status).toBe("interrupted");
  });
});
