import { describe, expect, it } from "vitest";
import { batchFinals } from "../../src/useRealtime";

describe("batch transcription conversion", () => {
  it("splits Qwen3-Omni speaker tags into persisted final events", () => {
    const events = batchFinals({
      text: "[spk_0] お電話ありがとうございます。\n[spk_1] 株価を教えてください。",
      duration: 4,
      wall: 1,
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "transcript.final",
      utterance_id: "batch-1",
      text: "お電話ありがとうございます。",
      latency_ms: 1000,
      rtf: 0.25,
    });
    expect(events[0].words?.[0].speaker).toBe("speaker_1");
    expect(events[1].words?.[0].speaker).toBe("speaker_2");
    expect(events[1].audio_end_ms).toBe(4000);
  });

  it("accepts a unified utterance response from the RunPod gateway", () => {
    const events = batchFinals({
      duration: 2,
      utterances: [{
        utterance_id: "utt-omni-1",
        text: "あかつき証券です。",
        speaker: "speaker_1",
        start_ms: 100,
        end_ms: 1700,
        confidence: 0.96,
      }],
    });

    expect(events).toEqual([
      expect.objectContaining({
        utterance_id: "utt-omni-1",
        text: "あかつき証券です。",
        audio_end_ms: 1700,
        words: [expect.objectContaining({ speaker: "speaker_1", confidence: 0.96 })],
      }),
    ]);
  });
});
