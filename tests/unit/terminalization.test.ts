import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTerminalCompletion, SessionTerminalizationLatch } from "../../src/terminalization";

afterEach(() => vi.useRealTimers());

describe("session terminalization", () => {
  it("uses one completion promise so a late status cannot overwrite the first terminal status", async () => {
    const latch = new SessionTerminalizationLatch();
    let release!: () => void;
    const firstOperation = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const conflictingOperation = vi.fn(async () => undefined);

    const completed = latch.run("session-1", firstOperation);
    const failed = latch.run("session-1", conflictingOperation);
    expect(failed).toBe(completed);
    await Promise.resolve();
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(conflictingOperation).not.toHaveBeenCalled();
    release();
    await completed;
  });

  it("retries the same terminal completion before surfacing a failure", async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    const result = retryTerminalCompletion(operation, [250, 750]);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("allows the same session to retry after a terminalization failure", async () => {
    const latch = new SessionTerminalizationLatch();
    const failed = vi.fn(async () => { throw new Error("offline"); });
    const retry = vi.fn(async () => undefined);

    await expect(latch.run("session-1", failed)).rejects.toThrow("offline");
    await expect(latch.run("session-1", retry)).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
