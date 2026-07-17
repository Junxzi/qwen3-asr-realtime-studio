import { describe, expect, it } from "vitest";
import {
  initialPipelineState,
  latestPipelineStages,
  parsePipelineStageEvent,
  pipelineReducer,
} from "../../src/pipeline";
import type { PipelineStageEvent } from "../../src/types";

const workerEvent = (
  overrides: Partial<PipelineStageEvent> = {},
): PipelineStageEvent => ({
  type: "pipeline.stage",
  seq: 1,
  pipeline_id: "pipeline-1",
  utterance_id: "utterance-1",
  stage: "vad",
  status: "running",
  audio_end_ms: null,
  elapsed_ms: null,
  detail_code: null,
  ...overrides,
});

describe("pipeline stage event parser", () => {
  it("accepts the complete worker event contract", () => {
    const event = workerEvent({
      stage: "endpoint",
      status: "completed",
      audio_end_ms: 1_480,
      elapsed_ms: 12,
      detail_code: "silence_480ms",
    });

    expect(parsePipelineStageEvent(event)).toEqual(event);
  });

  it.each([
    { ...workerEvent(), type: "transcript.partial" },
    { ...workerEvent(), seq: 0 },
    { ...workerEvent(), pipeline_id: "" },
    { ...workerEvent(), utterance_id: "" },
    { ...workerEvent(), stage: "unknown_stage" },
    { ...workerEvent(), status: "unknown_status" },
    { ...workerEvent(), audio_end_ms: -1 },
    { ...workerEvent(), elapsed_ms: Number.NaN },
    { ...workerEvent(), detail_code: 42 },
    { type: "pipeline.stage" },
    null,
  ])("rejects an invalid event: %#", (event) => {
    expect(parsePipelineStageEvent(event)).toBeNull();
  });
});

describe("pipeline reducer", () => {
  it("ignores duplicate and out-of-order worker sequence numbers", () => {
    const accepted = pipelineReducer(initialPipelineState, {
      type: "worker",
      event: workerEvent({ seq: 2, stage: "context_asr", status: "running" }),
      receivedAt: "2026-07-17T00:00:02.000Z",
    });
    const duplicate = pipelineReducer(accepted, {
      type: "worker",
      event: workerEvent({ seq: 2, stage: "context_asr", status: "completed" }),
      receivedAt: "2026-07-17T00:00:03.000Z",
    });
    const outOfOrder = pipelineReducer(duplicate, {
      type: "worker",
      event: workerEvent({ seq: 1, stage: "context_asr", status: "failed" }),
      receivedAt: "2026-07-17T00:00:04.000Z",
    });

    expect(duplicate).toBe(accepted);
    expect(outOfOrder).toBe(accepted);
    expect(outOfOrder.latestWorkerSeq).toBe(2);
    expect(outOfOrder.utterances["utterance-1"]?.stages.context_asr?.status).toBe("running");
    expect(outOfOrder.log).toHaveLength(1);
  });

  it("retains stage snapshots for multiple utterances", () => {
    const first = pipelineReducer(initialPipelineState, {
      type: "worker",
      event: workerEvent({ seq: 1, utterance_id: "utterance-1", stage: "vad" }),
      receivedAt: "2026-07-17T00:00:01.000Z",
    });
    const second = pipelineReducer(first, {
      type: "worker",
      event: workerEvent({ seq: 2, utterance_id: "utterance-2", stage: "context_asr" }),
      receivedAt: "2026-07-17T00:00:02.000Z",
    });

    expect(Object.keys(second.utterances)).toEqual(["utterance-1", "utterance-2"]);
    expect(second.utterances["utterance-1"]?.stages.vad?.utteranceId).toBe("utterance-1");
    expect(second.utterances["utterance-2"]?.stages.context_asr?.utteranceId).toBe("utterance-2");
    expect(second.latestWorkerUtteranceId).toBe("utterance-2");
  });

  it("stores the actual client receivedAt value without synthesizing a timestamp", () => {
    const receivedAt = "2026-07-17T03:04:05.678Z";
    const state = pipelineReducer(initialPipelineState, {
      type: "client",
      event: {
        utteranceId: "utterance-3",
        stage: "persist",
        status: "running",
        receivedAt,
        pipelineId: "hybrid",
        detailCode: "save_started",
      },
    });

    expect(state.utterances["utterance-3"]?.stages.persist?.receivedAt).toBe(receivedAt);
    expect(state.log[0]).toMatchObject({
      source: "client",
      received_at: receivedAt,
      utterance_id: "utterance-3",
      stage: "persist",
      status: "running",
    });
  });

  it("keeps the newest worker utterance visible when an older save finishes later", () => {
    const first = pipelineReducer(initialPipelineState, {
      type: "worker",
      event: workerEvent({ seq: 1, utterance_id: "utterance-1", stage: "endpoint" }),
      receivedAt: "2026-07-17T00:00:01.000Z",
    });
    const second = pipelineReducer(first, {
      type: "worker",
      event: workerEvent({ seq: 2, utterance_id: "utterance-2", stage: "vad" }),
      receivedAt: "2026-07-17T00:00:02.000Z",
    });
    const savedOlder = pipelineReducer(second, {
      type: "client",
      event: {
        utteranceId: "utterance-1",
        stage: "persist",
        status: "completed",
        receivedAt: "2026-07-17T00:00:03.000Z",
      },
    });

    expect(savedOlder.latestUtteranceId).toBe("utterance-2");
    expect(savedOlder.utterances["utterance-1"]?.stages.persist?.status).toBe("completed");
  });

  it("aggregates the latest stage across utterances so an older running finalizer remains visible", () => {
    const finalizingOlder = pipelineReducer(initialPipelineState, {
      type: "client",
      event: {
        utteranceId: "utterance-1",
        stage: "lab_finalizer",
        status: "running",
        receivedAt: "2026-07-17T00:00:01.000Z",
      },
    });
    const speakingNewer = pipelineReducer(finalizingOlder, {
      type: "worker",
      event: workerEvent({ seq: 1, utterance_id: "utterance-2", stage: "vad", status: "running" }),
      receivedAt: "2026-07-17T00:00:02.000Z",
    });

    expect(latestPipelineStages(speakingNewer)).toMatchObject({
      lab_finalizer: { utteranceId: "utterance-1", status: "running" },
      vad: { utteranceId: "utterance-2", status: "running" },
    });
  });
});
