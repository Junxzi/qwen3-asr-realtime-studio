import { describe, expect, it } from "vitest";
import type { KnownWorkerConfig } from "../../server/types.js";
import { MemoryWorkerPoolStore } from "../../server/worker-store.js";

function staticWorker(id: string, modelId: string): KnownWorkerConfig {
  return {
    id,
    podId: `pod-${id}`,
    name: `Worker ${id}`,
    serviceUrl: `https://pod-${id}-8000.proxy.runpod.net`,
    modelId,
    runtime: "realtime",
    maxSessions: 1,
    enabled: true,
  };
}

describe("memory worker pool store", () => {
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
    expect(touched).toMatchObject({ status: "active" });
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
});
