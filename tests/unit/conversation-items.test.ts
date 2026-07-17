import { describe, expect, it } from "vitest";
import { historyConversationItems, liveConversationItems } from "../../src/conversationProjection";
import type { FinalEvent, TranscriptUtterance } from "../../src/types";

describe("live conversation projection", () => {
  it("renders authoritative speaker turns as separate bubbles without changing the source utterance", () => {
    const event: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-1",
      revision: 2,
      text: "こんにちは\nよろしく",
      audio_start_ms: 10_000,
      audio_end_ms: 12_000,
      authoritative: true,
      finalization_status: "authoritative",
      speaker_turns: [
        { text: "こんにちは", speaker: "speaker_1", start_ms: 0, end_ms: 900 },
        { text: "よろしく", speaker: "speaker_2", start_ms: 900, end_ms: 2_000 },
      ],
    };

    expect(liveConversationItems([event], "2026-07-17T00:00:00.000Z")).toMatchObject([
      {
        id: "utterance-1:turn:0",
        speaker: "speaker_1",
        text: "こんにちは",
        audioStartMs: 10_000,
        audioEndMs: 10_900,
      },
      {
        id: "utterance-1:turn:1",
        speaker: "speaker_2",
        text: "よろしく",
        audioStartMs: 10_900,
        audioEndMs: 12_000,
      },
    ]);
    expect(event.utterance_id).toBe("utterance-1");
  });

  it("stops showing pending state after a fallback", () => {
    const [item] = liveConversationItems([{
      type: "transcript.final",
      utterance_id: "utterance-2",
      text: "リアルタイム結果",
      authoritative: false,
      finalization_status: "fallback",
    }]);

    expect(item.provisional).toBe(false);
    expect(item.fallback).toBe(true);
  });

  it("reconstructs contiguous speaker bubbles from persisted words", () => {
    const utterance: TranscriptUtterance = {
      id: "stored-1",
      session_id: "session-1",
      utterance_id: "utterance-1",
      revision: 2,
      sequence: 1,
      speaker: "speaker_1",
      text: "こんにちは よろしく また後で",
      words: [
        { text: "こんにちは", speaker: "speaker_1", start_ms: 0, end_ms: 500 },
        { text: "よろしく", speaker: "speaker_2", start_ms: 500, end_ms: 1_200 },
        { text: "また後で", speaker: "speaker_1", start_ms: 1_200, end_ms: 2_000 },
      ],
      audio_start_ms: 10_000,
      audio_end_ms: 12_000,
      context_hits: [],
      latency_ms: 20,
      queue_ms: 0,
      rtf: 0.1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
    };

    expect(historyConversationItems([utterance])).toMatchObject([
      { id: "stored-1:speaker-turn:0", speaker: "speaker_1", text: "こんにちは", audioStartMs: 10_000 },
      { id: "stored-1:speaker-turn:1", speaker: "speaker_2", text: "よろしく", audioStartMs: 10_500 },
      { id: "stored-1:speaker-turn:2", speaker: "speaker_1", text: "また後で", audioStartMs: 11_200 },
    ]);
  });
});
