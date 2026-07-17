import { describe, expect, it } from "vitest";
import type { KnownWorkerConfig, WorkerRuntime } from "../../server/types.js";
import { buildWorkerDecrementPlan, MemoryWorkerPoolStore } from "../../server/worker-store.js";

function staticWorker(id: string, modelId: string, runtime: WorkerRuntime = "realtime"): KnownWorkerConfig {
  return {
    id,
    podId: `pod-${id}`,
    name: `Worker ${id}`,
    serviceUrl: `https://pod-${id}-8000.proxy.runpod.net`,
    modelId,
    runtime,
    maxSessions: 1,
    enabled: true,
  };
}

describe("memory worker pool store", () => {
  it("plans worker decrements by worker ID instead of assignment UUID order", () => {
    const assignments = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        workerId: "worker-z",
        status: "active",
      },
      {
        id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        workerId: "worker-a",
        status: "ready",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        workerId: "worker-a",
        status: "active",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        workerId: "worker-ignored",
        status: "released",
      },
    ];

    expect(buildWorkerDecrementPlan(assignments)).toEqual([
      { workerId: "worker-a", count: 2 },
      { workerId: "worker-z", count: 1 },
    ]);
  });

  it("disables a removed static worker even while it still has an active session", async () => {
    const store = new MemoryWorkerPoolStore();
    const removed = staticWorker("removed", "model-removed");
    await store.seedKnownWorkers([removed], new Date(0));
    await store.updateWorker(removed.id, {
      status: "ready",
      activeSessions: 1,
    }, new Date(1));

    await store.seedKnownWorkers([staticWorker("replacement", "model-replacement")], new Date(2));

    expect(await store.getWorker(removed.id)).toMatchObject({
      enabled: false,
      activeSessions: 1,
      status: "ready",
    });

    await store.updateWorker(removed.id, { activeSessions: 0 }, new Date(3));
    const assignment = await store.createRequestedAssignment({
      sessionId: "00000000-0000-4000-8000-000000000041",
      modelId: removed.modelId,
      purpose: "realtime",
      now: new Date(4),
      leaseSeconds: 60,
    });
    expect((await store.reserveReadyWorker(assignment.id, new Date(4), 60)).status).toBe("requested");
  });

  it("keeps a concurrently touched lease instead of reaping the session", async () => {
    const store = new MemoryWorkerPoolStore();
    const worker = staticWorker("lease-worker", "lease-model");
    await store.seedKnownWorkers([worker], new Date(0));
    await store.updateWorker(worker.id, { status: "ready" }, new Date(0));
    const sessionId = "00000000-0000-4000-8000-000000000071";
    const assignment = await store.createRequestedAssignment({
      sessionId,
      modelId: worker.modelId,
      purpose: "realtime",
      now: new Date(0),
      leaseSeconds: 1,
    });
    await store.reserveReadyWorker(assignment.id, new Date(0), 1);

    const touchPromise = store.touch(sessionId, new Date(1_001), 60);
    const reapPromise = store.reapExpired(new Date(1_001));
    const [touched, reaped] = await Promise.all([touchPromise, reapPromise]);

    expect(reaped).toBe(0);
    expect(touched).toEqual([expect.objectContaining({ status: "active" })]);
    expect(await store.getAssignmentBySession(sessionId)).toMatchObject({ status: "active" });
    expect(await store.getWorker(worker.id)).toMatchObject({ activeSessions: 1 });
  });

  it("rejects duplicate Pod IDs when seeding or finalizing workers", async () => {
    const store = new MemoryWorkerPoolStore();
    const first = staticWorker("first", "model-a");
    const duplicate = { ...staticWorker("duplicate", "model-b"), podId: first.podId };

    await expect(store.seedKnownWorkers([first, duplicate], new Date(0))).rejects.toMatchObject({
      code: "duplicate_worker_pod_id",
      status: 409,
    });

    await store.seedKnownWorkers([first], new Date(0));
    const claim = await store.claimProvisioningWorker({
      ...staticWorker("dynamic", "model-dynamic"),
      podId: "",
      serviceUrl: "https://provisioning.invalid",
    }, 2, new Date(1));
    expect(claim).toMatchObject({ acquired: true });
    await expect(store.finalizeProvisioningWorker("dynamic", {
      podId: first.podId,
      name: "Duplicate dynamic worker",
      serviceUrl: "https://duplicate-dynamic-8000.proxy.runpod.net",
    }, new Date(2))).rejects.toMatchObject({
      code: "duplicate_worker_pod_id",
      status: 409,
    });
  });

  it("does not resurrect a released assignment when provisioning completes late", async () => {
    const store = new MemoryWorkerPoolStore();
    const sessionId = "00000000-0000-4000-8000-000000000072";
    const assignment = await store.createRequestedAssignment({
      sessionId,
      modelId: "model-delayed",
      purpose: "realtime",
      now: new Date(0),
      leaseSeconds: 60,
    });
    await store.markProvisioning(assignment.id, "worker-delayed", "provisioning", new Date(1), 60);
    await store.release(sessionId, new Date(2));

    await expect(store.markProvisioning(
      assignment.id,
      "worker-delayed",
      "late completion",
      new Date(3),
      60,
    )).resolves.toMatchObject({ status: "released" });
    expect(await store.getAssignmentBySession(sessionId)).toMatchObject({ status: "released" });
  });

  it("keeps realtime and batch assignments independent for a hybrid session", async () => {
    const store = new MemoryWorkerPoolStore();
    const realtime = staticWorker("hybrid-realtime", "model-realtime");
    const batch = staticWorker("hybrid-batch", "model-final", "batch");
    await store.seedKnownWorkers([realtime, batch], new Date(0));
    await store.updateWorker(realtime.id, { status: "ready" }, new Date(0));
    await store.updateWorker(batch.id, { status: "ready" }, new Date(0));
    const sessionId = "00000000-0000-4000-8000-000000000081";

    const realtimeAssignment = await store.createRequestedAssignment({
      sessionId,
      modelId: realtime.modelId,
      purpose: "realtime",
      now: new Date(1),
      leaseSeconds: 60,
    });
    const batchAssignment = await store.createRequestedAssignment({
      sessionId,
      modelId: batch.modelId,
      purpose: "batch",
      now: new Date(1),
      leaseSeconds: 60,
    });
    const realtimeRetry = await store.createRequestedAssignment({
      sessionId,
      modelId: realtime.modelId,
      purpose: "realtime",
      now: new Date(2),
      leaseSeconds: 60,
    });

    expect(realtimeRetry.id).toBe(realtimeAssignment.id);
    expect(batchAssignment.id).not.toBe(realtimeAssignment.id);
    await store.reserveReadyWorker(realtimeAssignment.id, new Date(3), 60);
    await store.reserveReadyWorker(batchAssignment.id, new Date(3), 60);
    expect(await store.listAssignmentsBySession(sessionId)).toEqual([
      expect.objectContaining({ id: realtimeAssignment.id, purpose: "realtime", status: "ready" }),
      expect.objectContaining({ id: batchAssignment.id, purpose: "batch", status: "ready" }),
    ]);
    expect(await store.touch(sessionId, new Date(4), 60)).toEqual([
      expect.objectContaining({ id: realtimeAssignment.id, status: "active" }),
      expect.objectContaining({ id: batchAssignment.id, status: "active" }),
    ]);

    await store.releaseAssignment(realtimeAssignment.id, new Date(5));
    expect(await store.getAssignmentBySession(sessionId, "realtime")).toMatchObject({ status: "released" });
    expect(await store.getAssignmentBySession(sessionId, "batch")).toMatchObject({ status: "active" });
    expect(await store.getWorker(realtime.id)).toMatchObject({ activeSessions: 0 });
    expect(await store.getWorker(batch.id)).toMatchObject({ activeSessions: 1 });

    expect(await store.release(sessionId, new Date(6))).toEqual([
      expect.objectContaining({ purpose: "realtime", status: "released" }),
      expect.objectContaining({ purpose: "batch", status: "released" }),
    ]);
    expect(await store.getWorker(batch.id)).toMatchObject({ activeSessions: 0 });
  });

  it("requeues only assignments owned by a lost worker and restores its capacity", async () => {
    const store = new MemoryWorkerPoolStore();
    const realtime = staticWorker("lost-realtime", "model-realtime");
    const batch = staticWorker("healthy-batch", "model-final", "batch");
    await store.seedKnownWorkers([realtime, batch], new Date(0));
    await store.updateWorker(realtime.id, { status: "ready" }, new Date(0));
    await store.updateWorker(batch.id, { status: "ready" }, new Date(0));
    const sessionId = "00000000-0000-4000-8000-000000000082";
    const realtimeAssignment = await store.createRequestedAssignment({
      sessionId,
      modelId: realtime.modelId,
      purpose: "realtime",
      now: new Date(1),
      leaseSeconds: 60,
    });
    const batchAssignment = await store.createRequestedAssignment({
      sessionId,
      modelId: batch.modelId,
      purpose: "batch",
      now: new Date(1),
      leaseSeconds: 60,
    });
    await store.reserveReadyWorker(realtimeAssignment.id, new Date(2), 60);
    await store.reserveReadyWorker(batchAssignment.id, new Date(2), 60);
    await store.touch(sessionId, new Date(3), 60);

    const requeued = await store.requeueAssignmentsForWorker(
      realtime.id,
      new Date(4),
      60,
      "worker lost",
    );

    expect(requeued).toEqual([
      expect.objectContaining({
        id: realtimeAssignment.id,
        workerId: null,
        status: "requested",
        message: "worker lost",
      }),
    ]);
    expect(await store.getAssignmentBySession(sessionId, "batch")).toMatchObject({
      id: batchAssignment.id,
      workerId: batch.id,
      status: "active",
    });
    expect(await store.getWorker(realtime.id)).toMatchObject({ activeSessions: 0 });
    expect(await store.getWorker(batch.id)).toMatchObject({ activeSessions: 1 });
    expect(await store.countActiveSessions(["ready", "active"])).toBe(1);
  });
});
