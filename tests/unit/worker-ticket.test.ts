import { describe, expect, it } from "vitest";
import { createWorkerTicket, verifyWorkerTicket, WORKER_TICKET_AUDIENCE } from "../../server/worker-ticket.js";

describe("worker tickets", () => {
  const secret = "worker-ticket-secret-at-least-32-characters";
  const pythonGolden = "eyJhdWQiOiJxd2VuLXJlYWx0aW1lLXdvcmtlciIsImV4cCI6MjAwMDAwMDAwMCwibWlkIjoib3JnL21vZGVsIiwicHVycG9zZSI6InJlYWx0aW1lIiwic2lkIjoic2Vzc2lvbi0xIiwidiI6MSwid2lkIjoid29ya2VyLTEifQ.BriGI2oOWurHL3HkdNTWnq00s1-RFFsZiBEAVQRp-Yw";

  it("binds the ticket to worker, session, model, purpose, and expiry", () => {
    const issued = createWorkerTicket({
      secret,
      workerId: "worker-a",
      sessionId: "session-a",
      modelId: "model-a",
      purpose: "realtime",
      nowMs: 1_000_000,
      ttlSeconds: 120,
    });
    expect(verifyWorkerTicket(issued.token, secret, 1_010_000)).toMatchObject({
      aud: WORKER_TICKET_AUDIENCE,
      wid: "worker-a",
      sid: "session-a",
      mid: "model-a",
      purpose: "realtime",
    });
  });

  it("rejects tampered and expired tickets", () => {
    const issued = createWorkerTicket({
      secret,
      workerId: "worker-a",
      sessionId: "session-a",
      modelId: "model-a",
      purpose: "batch",
      nowMs: 1_000_000,
      ttlSeconds: 10,
    });
    expect(verifyWorkerTicket(`${issued.token}x`, secret, 1_001_000)).toBeNull();
    expect(verifyWorkerTicket(issued.token, secret, 1_011_000)).toBeNull();
    expect(verifyWorkerTicket(issued.token, `${secret}-wrong`, 1_001_000)).toBeNull();
  });

  it("verifies the Python worker golden ticket", () => {
    expect(verifyWorkerTicket(pythonGolden, secret, 1_999_999_999_000)).toMatchObject({
      v: 1,
      wid: "worker-1",
      sid: "session-1",
      mid: "org/model",
      purpose: "realtime",
      exp: 2_000_000_000,
    });
  });
});
