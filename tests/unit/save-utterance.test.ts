import { afterEach, describe, expect, it, vi } from "vitest";
import { saveUtteranceWithTimeout, shouldReportFinalPersistence } from "../../src/saveUtterance";
import type { PersistUtteranceInput, TranscriptUtterance } from "../../src/types";

const payload: PersistUtteranceInput = {
  revision: 1,
  text: "保存対象",
  words: [],
  context_hits: [],
  audio_end_ms: 1_000,
  latency_ms: null,
  queue_ms: null,
  rtf: null,
};

describe("bounded utterance save", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts a save request after the configured timeout", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const save = vi.fn((
      _sessionId: string,
      _utteranceId: string,
      _payload: PersistUtteranceInput,
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      return new Promise<TranscriptUtterance>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const saving = saveUtteranceWithTimeout("session", "utterance", payload, 250, save);
    const rejected = expect(saving).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(250);

    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("clears the timeout after a successful save", async () => {
    vi.useFakeTimers();
    const result = { id: "saved" } as TranscriptUtterance;
    const save = vi.fn(async () => result);

    await expect(saveUtteranceWithTimeout("session", "utterance", payload, 250, save)).resolves.toBe(result);
    await vi.advanceTimersByTimeAsync(250);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("persistence pipeline status", () => {
  it("does not report provisional hybrid saves as final persistence", () => {
    expect(shouldReportFinalPersistence({
      type: "transcript.final",
      utterance_id: "pending",
      text: "暫定",
      finalization_status: "pending",
    })).toBe(false);
    expect(shouldReportFinalPersistence({
      type: "transcript.final",
      utterance_id: "authoritative",
      text: "確定",
      finalization_status: "authoritative",
    })).toBe(true);
    expect(shouldReportFinalPersistence({
      type: "transcript.final",
      utterance_id: "fallback",
      text: "リアルタイム確定",
      finalization_status: "fallback",
    })).toBe(true);
  });
});
