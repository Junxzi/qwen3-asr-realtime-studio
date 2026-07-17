import { describe, expect, it } from "vitest";
import {
  assignmentIsReady,
  assignmentMessage,
  assignmentPollDelay,
  assertAssignmentMatches,
  requireAssignmentConnection,
} from "../../src/assignment";
import type { InferenceAssignment } from "../../src/types";

function assignment(overrides: Partial<InferenceAssignment> = {}): InferenceAssignment {
  return {
    id: "assignment-1",
    session_id: "session-1",
    model_id: "infodeliverailab/context",
    purpose: "realtime",
    status: "requested",
    ...overrides,
  };
}

describe("inference assignment helpers", () => {
  it("uses bounded server-directed polling delays", () => {
    expect(assignmentPollDelay(assignment())).toBe(1_500);
    expect(assignmentPollDelay(assignment({ retry_after_ms: 10 }))).toBe(500);
    expect(assignmentPollDelay(assignment({ retry_after_ms: 30_000 }))).toBe(5_000);
  });

  it("reports GPU and model provisioning without invented progress", () => {
    expect(assignmentMessage(assignment())).toBe("利用可能なGPUを探しています");
    expect(assignmentMessage(assignment({ status: "provisioning" }))).toBe("GPUを準備しています");
    expect(assignmentMessage(assignment({
      status: "provisioning",
      worker: { id: "worker-1", pod_id: "pod-1", loaded_model_id: "another-model" },
    }), "Context Full-FT")).toBe("Context Full-FTを読み込んでいます");
    expect(assignmentMessage(assignment({ status: "failed", message: "A100の空きがありません" })))
      .toBe("A100の空きがありません");
  });

  it("accepts only a ready purpose-specific connection", () => {
    const ready = assignment({
      status: "ready",
      connection: {
        websocket_url: "wss://worker.example/v1/realtime",
        ticket: "ticket-1",
        expires_at: "2026-07-17T01:00:00.000Z",
      },
    });
    expect(assignmentIsReady(ready)).toBe(true);
    expect(requireAssignmentConnection(ready, "realtime").ticket).toBe("ticket-1");
    expect(() => requireAssignmentConnection(ready, "batch")).toThrow("処理方式が一致しません");
  });

  it("rejects a response for another session or model", () => {
    expect(() => assertAssignmentMatches(assignment(), { id: "another-session", model_id: "infodeliverailab/context" }))
      .toThrow("セッションが一致しません");
    expect(() => assertAssignmentMatches(assignment(), { id: "session-1", model_id: "another-model" }))
      .toThrow("モデルが一致しません");
  });
});
