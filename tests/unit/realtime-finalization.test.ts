import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalizationDrain } from "../../src/realtimeFinalization";

afterEach(() => {
  vi.useRealTimers();
});

describe("realtime finalization drain", () => {
  it("does not treat a final as completion until a capable worker acknowledges the stream", async () => {
    vi.useFakeTimers();
    const drain = new FinalizationDrain({ mode: "ack", timeoutMs: 10_000 });
    const result = drain.wait();
    let settled = false;
    void result.finally(() => { settled = true; });

    drain.notifyFinal("tail");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    drain.notifyFinalized();
    await expect(result).resolves.toBe("acknowledged");
  });

  it("rejects instead of silently completing when the worker acknowledgement times out", async () => {
    vi.useFakeTimers();
    const drain = new FinalizationDrain({ mode: "ack", timeoutMs: 10_000 });
    const result = drain.wait();
    const assertion = expect(result).rejects.toThrow("セッションは完了していません");

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("keeps a legacy stream open for a pending utterance until its matching final", async () => {
    vi.useFakeTimers();
    const drain = new FinalizationDrain({
      mode: "legacy",
      pendingUtteranceId: "tail",
      quietMs: 1_000,
      timeoutMs: 5_000,
    });
    const result = drain.wait();
    let settled = false;
    void result.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);
    drain.notifyFinal("older");
    expect(settled).toBe(false);
    drain.notifyFinal("tail");
    await expect(result).resolves.toBe("tail-final");
  });

  it("uses a resettable quiet window and a five second hard bound for legacy workers", async () => {
    vi.useFakeTimers();
    const quietDrain = new FinalizationDrain({ mode: "legacy", quietMs: 1_000, timeoutMs: 5_000 });
    const quietResult = quietDrain.wait();
    await vi.advanceTimersByTimeAsync(800);
    quietDrain.notifyActivity();
    await vi.advanceTimersByTimeAsync(999);
    let quietSettled = false;
    void quietResult.finally(() => { quietSettled = true; });
    expect(quietSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(quietResult).resolves.toBe("quiet");

    const boundedDrain = new FinalizationDrain({
      mode: "legacy",
      pendingUtteranceId: "tail",
      quietMs: 1_000,
      timeoutMs: 5_000,
    });
    const boundedResult = boundedDrain.wait();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(boundedResult).resolves.toBe("timeout");
  });

  it("rejects immediately when the socket terminates during the drain", async () => {
    const drain = new FinalizationDrain({ mode: "ack" });
    const result = drain.wait();
    drain.fail(new Error("socket closed"));
    await expect(result).rejects.toThrow("socket closed");
  });
});
