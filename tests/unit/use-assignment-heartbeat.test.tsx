// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import type { AssignmentPurpose, ProcessingProfile } from "../../src/types";
import { useAssignmentHeartbeat } from "../../src/useAssignmentHeartbeat";

type HeartbeatProfile = Pick<ProcessingProfile, "id" | "assignments">;

const realtimeProfile: HeartbeatProfile = {
  id: "realtime",
  assignments: [{ purpose: "realtime", model_id: "realtime-model" }],
};

const batchProfile: HeartbeatProfile = {
  id: "batch",
  assignments: [{ purpose: "batch", model_id: "batch-model" }],
};

const hybridProfile: HeartbeatProfile = {
  id: "hybrid",
  assignments: [
    { purpose: "realtime", model_id: "realtime-model" },
    { purpose: "batch", model_id: "batch-model" },
  ],
};

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("assignment heartbeat lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let heartbeat!: ReturnType<typeof useAssignmentHeartbeat>;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderHarness(
    sender: (
      sessionId: string,
      purpose: AssignmentPurpose,
      signal: AbortSignal,
    ) => Promise<unknown>,
    onLeaseLost?: (error: Error, sessionId: string) => void,
  ) {
    function Harness() {
      heartbeat = useAssignmentHeartbeat(onLeaseLost, sender, 1_000);
      return null;
    }
    return act(async () => root.render(<Harness />));
  }

  it("renews a realtime lease immediately and periodically, then stops", async () => {
    const sender = vi.fn(async (
      _sessionId: string,
      _purpose: AssignmentPurpose,
      _signal: AbortSignal,
    ) => {
      void _sessionId;
      void _purpose;
      void _signal;
    });
    await renderHarness(sender);

    await act(async () => {
      heartbeat.start("session-1", realtimeProfile);
      await flushMicrotasks();
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[0]).toBe("session-1");
    expect(sender.mock.calls[0]?.[1]).toBe("realtime");

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(sender).toHaveBeenCalledTimes(3);

    heartbeat.stop("session-1");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("renews both hybrid leases independently", async () => {
    const sender = vi.fn(async (
      _sessionId: string,
      _purpose: AssignmentPurpose,
      _signal: AbortSignal,
    ) => {
      void _sessionId;
      void _purpose;
      void _signal;
    });
    await renderHarness(sender);

    await act(async () => {
      heartbeat.start("session-1", hybridProfile);
      await flushMicrotasks();
    });
    expect(sender.mock.calls.map((call) => call[1]).sort()).toEqual(["batch", "realtime"]);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(sender).toHaveBeenCalledTimes(4);
    expect(sender.mock.calls.filter((call) => call[1] === "realtime")).toHaveLength(2);
    expect(sender.mock.calls.filter((call) => call[1] === "batch")).toHaveLength(2);
  });

  it("keeps renewing realtime while a hybrid batch heartbeat is in flight", async () => {
    const sender = vi.fn(async (_sessionId: string, purpose: AssignmentPurpose) => {
      if (purpose === "batch") await new Promise(() => undefined);
    });
    await renderHarness(sender);

    await act(async () => {
      heartbeat.start("session-1", hybridProfile);
      await flushMicrotasks();
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(sender.mock.calls.filter((call) => call[1] === "batch")).toHaveLength(1);
    expect(sender.mock.calls.filter((call) => call[1] === "realtime")).toHaveLength(3);
  });

  it("aborts every in-flight purpose when stopped", async () => {
    const observedSignals = new Map<AssignmentPurpose, AbortSignal>();
    const sender = vi.fn((
      _sessionId: string,
      purpose: AssignmentPurpose,
      signal: AbortSignal,
    ) => {
      observedSignals.set(purpose, signal);
      return new Promise<unknown>(() => undefined);
    });
    await renderHarness(sender);

    heartbeat.start("session-1", hybridProfile);
    expect(sender).toHaveBeenCalledTimes(2);
    heartbeat.stop("session-1");

    expect(observedSignals.get("realtime")?.aborted).toBe(true);
    expect(observedSignals.get("batch")?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it.each([404, 409])("treats hybrid batch HTTP %s as retryable", async (status) => {
    const failure = new ApiError(status, "assignment_not_active", "batch unavailable");
    const sender = vi.fn(async (_sessionId: string, purpose: AssignmentPurpose) => {
      if (purpose === "batch") throw failure;
    });
    const onLeaseLost = vi.fn();
    await renderHarness(sender, onLeaseLost);

    await act(async () => {
      heartbeat.start("session-1", hybridProfile);
      await flushMicrotasks();
    });
    expect(onLeaseLost).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(sender.mock.calls.filter((call) => call[1] === "batch")).toHaveLength(2);
    expect(sender.mock.calls.filter((call) => call[1] === "realtime")).toHaveLength(2);
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  it.each([404, 409])("treats realtime HTTP %s as fatal and stops all hybrid leases", async (status) => {
    const failure = new ApiError(status, "assignment_not_active", "realtime lease lost");
    let batchSignal: AbortSignal | undefined;
    const sender = vi.fn((
      _sessionId: string,
      purpose: AssignmentPurpose,
      signal: AbortSignal,
    ) => {
      if (purpose === "realtime") return Promise.reject(failure);
      batchSignal = signal;
      return new Promise<unknown>(() => undefined);
    });
    const onLeaseLost = vi.fn();
    await renderHarness(sender, onLeaseLost);

    await act(async () => {
      heartbeat.start("session-1", hybridProfile);
      await flushMicrotasks();
    });
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(onLeaseLost).toHaveBeenCalledWith(failure, "session-1");
    expect(batchSignal?.aborted).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it.each([404, 409])("treats batch-only HTTP %s as fatal", async (status) => {
    const failure = new ApiError(status, "assignment_not_active", "batch lease lost");
    const sender = vi.fn(async () => { throw failure; });
    const onLeaseLost = vi.fn();
    await renderHarness(sender, onLeaseLost);

    await act(async () => {
      heartbeat.start("session-1", batchProfile);
      await flushMicrotasks();
    });
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(onLeaseLost).toHaveBeenCalledWith(failure, "session-1");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
