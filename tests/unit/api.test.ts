import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/api";

function heartbeatResponse() {
  return new Response(JSON.stringify({
    data: {
      status: "active",
      lease_expires_at: "2026-07-17T00:01:00.000Z",
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("control API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a purpose-scoped assignment heartbeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(heartbeatResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.heartbeatAssignment("session/one", "batch");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/transcriptions/session%2Fone/assignment/heartbeat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ purpose: "batch" });
  });

  it("keeps an unscoped heartbeat backward compatible", async () => {
    const fetchMock = vi.fn().mockResolvedValue(heartbeatResponse());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.heartbeatAssignment("session-2", undefined, controller.signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(init.signal).toBe(controller.signal);
  });
});
