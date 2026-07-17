import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batchFinals,
  createBatchRequestDeadline,
  enqueueSerial,
  hybridFallbackFinal,
  hybridFinalFromBatch,
  isCurrentHybridFinalization,
  normalizeRealtimeFinalSpeakers,
  refreshHybridBatchAssignment,
  runBatchRequestWithDeadline,
  scheduleHybridFallbackDelivery,
  scheduleHybridFinalization,
  shouldUpsertFinal,
} from "../../src/useRealtime";
import type { FinalEvent, InferenceAssignment, TranscriptionSession } from "../../src/types";

describe("batchFinals speaker markers", () => {
  it.each([
    ["worker marker", "<|spk_0|>こんにちは<|spk_1|>よろしく"],
    ["legacy marker", "[spk_0]こんにちは[spk_1]よろしく"],
  ])("parses %s into speaker turns", (_label, text) => {
    const finals = batchFinals({ text, duration: 2 });

    expect(finals.map((event) => event.text)).toEqual(["こんにちは", "よろしく"]);
    expect(finals.map((event) => event.words?.[0]?.speaker)).toEqual(["speaker_1", "speaker_2"]);
  });

  it("normalizes structured zero-based speakers to one-based UI speakers", () => {
    const finals = batchFinals({
      duration: 2,
      utterances: [
        { text: "話者A", speaker: "speaker_0", start_ms: 0, end_ms: 1_000 },
        { text: "話者B", speaker: "speaker_1", start_ms: 1_000, end_ms: 2_000 },
      ],
    });

    expect(finals.map((event) => event.words?.[0]?.speaker)).toEqual(["speaker_1", "speaker_2"]);
    expect(finals[1]).toMatchObject({
      audio_start_ms: 1_000,
      audio_end_ms: 2_000,
      words: [{ start_ms: 0, end_ms: 1_000 }],
    });
  });

  it("keeps an isolated worker speaker_1 as public speaker_2", () => {
    const [structured] = batchFinals({
      duration: 1,
      utterances: [
        { text: "話者Bのみ", speaker: "speaker_1", start_ms: 0, end_ms: 1_000 },
      ],
    });
    const [marked] = batchFinals({
      duration: 1,
      text: "<|spk_1|>話者Bのみ",
    });

    expect(structured?.words?.[0]?.speaker).toBe("speaker_2");
    expect(marked?.words?.[0]?.speaker).toBe("speaker_2");
  });

  it("keeps file offsets absolute while word offsets remain event-relative", () => {
    const finals = batchFinals({
      duration: 3,
      turns: [
        { text: "前半", speaker: "speaker_0", start_ms: 500, end_ms: 1_250 },
        { text: "後半", speaker: "speaker_1", start_ms: 1_250, end_ms: 2_750 },
      ],
      utterance_id: "file-result",
    });

    expect(finals).toMatchObject([
      {
        utterance_id: "file-result:1",
        audio_start_ms: 500,
        audio_end_ms: 1_250,
        words: [{ start_ms: 0, end_ms: 750 }],
      },
      {
        utterance_id: "file-result:2",
        audio_start_ms: 1_250,
        audio_end_ms: 2_750,
        words: [{ start_ms: 0, end_ms: 1_500 }],
      },
    ]);
  });
});

describe("realtime speaker normalization", () => {
  it("converts worker speaker_0/1 labels to one-based final API labels", () => {
    const normalized = normalizeRealtimeFinalSpeakers({
      type: "transcript.final",
      utterance_id: "utterance",
      text: "話者A 話者B",
      words: [
        { text: "話者A", speaker: "speaker_0", start_ms: 0, end_ms: 500 },
        { text: "話者B", speaker: "speaker_1", start_ms: 500, end_ms: 1_000 },
      ],
    });

    expect(normalized.words?.map((word) => word.speaker)).toEqual(["speaker_1", "speaker_2"]);
  });
});

describe("hybridFinalFromBatch", () => {
  it("replaces a provisional final with a higher authoritative revision at the same absolute bounds", () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-7",
      revision: 4,
      text: "暫定結果",
      words: [{
        text: "暫定結果",
        speaker: "speaker_2",
        start_ms: 0,
        end_ms: 2_520,
      }],
      context_hits: ["専門語"],
      audio_start_ms: 12_340,
      audio_end_ms: 14_860,
      authoritative: false,
    };

    const final = hybridFinalFromBatch({
      duration: 2.52,
      utterances: [{
        utterance_id: "batch-result-1",
        text: "話者付き確定結果",
        speaker: "speaker_0",
        start_ms: 0,
        end_ms: 2_520,
      }],
    }, provisional);

    expect(final).toMatchObject({
      utterance_id: "utterance-7",
      revision: 5,
      text: "話者付き確定結果",
      authoritative: true,
      finalization_status: "authoritative",
      audio_start_ms: 12_340,
      audio_end_ms: 14_860,
      context_hits: ["専門語"],
    });
    expect(final.speaker_turns).toEqual(final.words);
    expect(final.words).toEqual([
      expect.objectContaining({ speaker: "speaker_2", start_ms: 0, end_ms: 2_520 }),
    ]);
  });

  it("restores segment offsets while projecting batch turns onto Sortformer speakers", () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-10",
      revision: 1,
      text: "前半 後半",
      words: [
        { text: "前半", speaker: "speaker_1", start_ms: 0, end_ms: 1_000 },
        { text: "後半", speaker: "speaker_2", start_ms: 1_000, end_ms: 2_000 },
      ],
      audio_start_ms: 10_000,
      audio_end_ms: 12_000,
      finalization_status: "pending",
    };

    const final = hybridFinalFromBatch({
      duration: 2,
      utterances: [
        { text: "確定前半", speaker: "speaker_0", start_ms: 0, end_ms: 1_000 },
        { text: "確定後半", speaker: "speaker_1", start_ms: 1_000, end_ms: 2_000 },
      ],
    }, provisional);

    expect(final.words).toEqual([
      expect.objectContaining({ speaker: "speaker_1", start_ms: 0, end_ms: 1_000 }),
      expect.objectContaining({ speaker: "speaker_2", start_ms: 1_000, end_ms: 2_000 }),
    ]);
    expect(final.audio_start_ms).toBe(10_000);
    expect(final.audio_end_ms).toBe(12_000);
  });

  it("projects a batch speaker identity once instead of flipping it word by word", () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-identity",
      revision: 2,
      text: "話者B 話者A",
      words: [
        { text: "話者B", speaker: "speaker_2", start_ms: 0, end_ms: 600 },
        { text: "話者A", speaker: "speaker_1", start_ms: 600, end_ms: 2_000 },
      ],
      audio_start_ms: 5_000,
      audio_end_ms: 7_000,
      finalization_status: "pending",
    };

    const final = hybridFinalFromBatch({
      duration: 2,
      utterances: [
        { text: "確定B", speaker: "speaker_0", start_ms: 0, end_ms: 600 },
        { text: "確定A", speaker: "speaker_0", start_ms: 600, end_ms: 2_000 },
      ],
    }, provisional);

    expect(new Set(final.words?.map((word) => word.speaker))).toEqual(new Set(["speaker_1"]));
    expect(final.words).toEqual([
      expect.objectContaining({ start_ms: 0, end_ms: 600 }),
      expect.objectContaining({ start_ms: 600, end_ms: 2_000 }),
    ]);
  });

  it("keeps the second lab speaker distinct when Sortformer observed only one speaker", () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-single-observed",
      revision: 1,
      text: "後半だけ話者が確定",
      words: [
        { text: "後半", speaker: "speaker_2", start_ms: 1_000, end_ms: 2_000 },
      ],
      audio_start_ms: 0,
      audio_end_ms: 2_000,
      finalization_status: "pending",
    };

    const final = hybridFinalFromBatch({
      duration: 2,
      utterances: [
        { text: "前半", speaker: "speaker_0", start_ms: 0, end_ms: 1_000 },
        { text: "後半", speaker: "speaker_1", start_ms: 1_000, end_ms: 2_000 },
      ],
    }, provisional);

    expect(final.words?.map((word) => word.speaker)).toEqual(["speaker_1", "speaker_2"]);
  });

  it("marks a failed finalizer as a terminal fallback without changing the revision", () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-8",
      revision: 2,
      text: "リアルタイム結果",
      authoritative: false,
      finalization_status: "pending",
    };

    expect(hybridFallbackFinal(provisional)).toMatchObject({
      utterance_id: "utterance-8",
      revision: 2,
      authoritative: false,
      finalization_status: "fallback",
    });
  });

  it("redelivers a fallback with the provisional revision for idempotent persistence", async () => {
    const provisional: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance-9",
      revision: 3,
      text: "リアルタイム結果",
      finalization_status: "pending",
    };
    const deliver = vi.fn(async () => undefined);
    const scheduled = scheduleHybridFallbackDelivery(provisional, "session-1", deliver);

    await scheduled.delivery;

    expect(scheduled.fallback).toMatchObject({
      utterance_id: provisional.utterance_id,
      revision: provisional.revision,
      finalization_status: "fallback",
    });
    expect(deliver).toHaveBeenCalledWith(scheduled.fallback, "session-1");
  });

  it("accepts only a newer revision or a stronger result at the same revision", () => {
    const pending: FinalEvent = {
      type: "transcript.final",
      utterance_id: "utterance",
      revision: 4,
      text: "暫定",
      finalization_status: "pending",
    };

    expect(shouldUpsertFinal(pending, hybridFallbackFinal(pending))).toBe(true);
    expect(shouldUpsertFinal(pending, { ...pending, revision: 5 })).toBe(true);
    expect(shouldUpsertFinal(
      { ...pending, revision: 5, authoritative: true, finalization_status: "authoritative" },
      pending,
    )).toBe(false);
    expect(shouldUpsertFinal(pending, { ...pending, text: "重複" })).toBe(false);
  });
});

describe("batch request deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("propagates a parent cancellation", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createBatchRequestDeadline(parent.signal, 500);
    const reason = new DOMException("cancelled", "AbortError");

    parent.abort(reason);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(deadline.timedOut()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("aborts after the configured timeout", async () => {
    vi.useFakeTimers();
    const deadline = createBatchRequestDeadline(undefined, 500);

    await vi.advanceTimersByTimeAsync(500);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it("cleans up the timeout after a completed request", async () => {
    vi.useFakeTimers();
    const deadline = createBatchRequestDeadline(undefined, 500);

    deadline.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes assignment preparation in the same request deadline", async () => {
    vi.useFakeTimers();
    const operation = runBatchRequestWithDeadline(
      undefined,
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      500,
    );
    const assertion = expect(operation).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(500);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hybrid finalizer generation guard", () => {
  const job = {
    generation: 4,
    session: { id: "session-current" } as TranscriptionSession,
  };

  it("accepts only the current generation of the same session", () => {
    expect(isCurrentHybridFinalization(job, 4, "session-current")).toBe(true);
    expect(isCurrentHybridFinalization(job, 5, "session-current")).toBe(false);
    expect(isCurrentHybridFinalization(job, 4, "session-new")).toBe(false);
    expect(isCurrentHybridFinalization(job, 4, undefined)).toBe(false);
  });
});

describe("hybrid finalizer queue", () => {
  it("runs finalizers serially even when the first task is still pending", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = enqueueSerial(Promise.resolve(), async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = enqueueSerial(first, async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not wait for provisional persistence before starting the finalizer", async () => {
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const events: string[] = [];
    const scheduled = scheduleHybridFinalization(
      Promise.resolve(),
      () => persistence,
      () => { events.push("finalizer:start"); },
    );

    await scheduled.queuedFinalization;
    expect(events).toEqual(["finalizer:start"]);
    let persisted = false;
    void scheduled.provisionalDelivery.then(() => { persisted = true; });
    expect(persisted).toBe(false);
    releasePersistence();
    await scheduled.provisionalDelivery;
    expect(persisted).toBe(true);
  });
});

describe("hybrid assignment refresh", () => {
  const session = {
    id: "session-1",
    model_id: "context-model",
  } as TranscriptionSession;
  const freshAssignment: InferenceAssignment = {
    id: "assignment-batch",
    session_id: session.id,
    model_id: "final-model",
    purpose: "batch",
    status: "ready",
    connection: {
      batch_url: "https://worker.example/v1/audio/transcriptions",
      ticket: "fresh-ticket",
      expires_at: "2026-07-17T12:00:00.000Z",
    },
  };

  it("requests and validates a fresh ready batch assignment", async () => {
    const calls: unknown[][] = [];
    const assignment = await refreshHybridBatchAssignment(
      session,
      "final-model",
      undefined,
      async (...args) => {
        calls.push(args);
        return freshAssignment;
      },
    );

    expect(calls).toEqual([[session.id, "batch", undefined]]);
    expect(assignment.connection?.ticket).toBe("fresh-ticket");
  });

  it("rejects a refreshed assignment for the wrong model", async () => {
    await expect(refreshHybridBatchAssignment(
      session,
      "another-model",
      undefined,
      async () => freshAssignment,
    )).rejects.toThrow("GPUの割り当てモデルが一致しません");
  });

  it.each([
    [{ ...freshAssignment, status: "provisioning" as const }, "GPUの割り当てがまだ準備できていません"],
    [{ ...freshAssignment, connection: undefined }, "GPU接続チケットを取得できませんでした"],
  ])("rejects a refreshed assignment that is not usable", async (unusable, message) => {
    await expect(refreshHybridBatchAssignment(
      session,
      "final-model",
      undefined,
      async () => unusable,
    )).rejects.toThrow(message);
  });
});
