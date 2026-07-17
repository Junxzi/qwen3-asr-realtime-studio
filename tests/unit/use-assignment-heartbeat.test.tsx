// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { useAssignmentHeartbeat } from "../../src/useAssignmentHeartbeat";

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

  it("renews immediately and periodically, then stops before terminalization", async () => {
    const sender = vi.fn(async () => undefined);
    function Harness() {
      heartbeat = useAssignmentHeartbeat(undefined, sender, 1_000);
      return null;
    }
    await act(async () => root.render(<Harness />));

    await act(async () => {
      heartbeat.start("session-1");
      await Promise.resolve();
    });
    expect(sender).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(sender).toHaveBeenCalledTimes(3);

    heartbeat.stop("session-1");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight heartbeat and cannot race after stop", async () => {
    let observedSignal!: AbortSignal;
    const sender = vi.fn((_sessionId: string, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    });
    function Harness() {
      heartbeat = useAssignmentHeartbeat(undefined, sender, 1_000);
      return null;
    }
    await act(async () => root.render(<Harness />));

    heartbeat.start("session-1");
    expect(sender).toHaveBeenCalledTimes(1);
    heartbeat.stop("session-1");
    expect(observedSignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("fails once and stops renewing when the server reports a lost lease", async () => {
    const failure = new ApiError(409, "assignment_not_active", "lease lost");
    const sender = vi.fn(async () => { throw failure; });
    const onLeaseLost = vi.fn();
    function Harness() {
      heartbeat = useAssignmentHeartbeat(onLeaseLost, sender, 1_000);
      return null;
    }
    await act(async () => root.render(<Harness />));

    await act(async () => {
      heartbeat.start("session-1");
      await Promise.resolve();
    });
    expect(onLeaseLost).toHaveBeenCalledWith(failure, "session-1");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sender).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
  });
});
