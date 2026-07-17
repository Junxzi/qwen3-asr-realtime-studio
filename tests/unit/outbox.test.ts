import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api";
import {
  OUTBOX_RETENTION_MS,
  outboxItemExpired,
  terminalOutboxFailure,
  type OutboxItem,
} from "../../src/outbox";

function item(createdAt: string): OutboxItem {
  return {
    key: "session:utterance",
    sessionId: "session",
    utteranceId: "utterance",
    payload: {
      revision: 0,
      text: "test",
      words: [],
      context_hits: [],
      audio_end_ms: 0,
      latency_ms: null,
      queue_ms: null,
      rtf: null,
    },
    createdAt,
  };
}

describe("transcription outbox retention", () => {
  it("expires records after the same 30-day window as server history", () => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    expect(outboxItemExpired(item(new Date(now - OUTBOX_RETENTION_MS + 1).toISOString()), now)).toBe(false);
    expect(outboxItemExpired(item(new Date(now - OUTBOX_RETENTION_MS).toISOString()), now)).toBe(true);
    expect(outboxItemExpired(item("invalid"), now)).toBe(true);
  });

  it("discards only terminal missing-history failures", () => {
    expect(terminalOutboxFailure(new ApiError(404, "not_found", "missing"))).toBe(true);
    expect(terminalOutboxFailure(new ApiError(410, "gone", "gone"))).toBe(true);
    expect(terminalOutboxFailure(new ApiError(503, "unavailable", "retry"))).toBe(false);
    expect(terminalOutboxFailure(new TypeError("network"))).toBe(false);
  });
});
