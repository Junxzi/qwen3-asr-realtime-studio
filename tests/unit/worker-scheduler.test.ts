import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config.js";
import { ProviderError } from "../../server/runpod.js";
import type { KnownWorkerConfig, PodInfo, WorkerRecord } from "../../server/types.js";
import type { CreateRunPodInput, RunPodFleetClient, WorkerAdminClient, WorkerProbe } from "../../server/worker-clients.js";
import { WorkerScheduler } from "../../server/worker-scheduler.js";
import { MemoryWorkerPoolStore } from "../../server/worker-store.js";

const modelId = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";
const finalModelId = "infodeliverailab/lab_asr_diarization_v1";

function createConfig(maxSessions = 1, workerCount = 2) {
  return loadConfig({
    NODE_ENV: "test",
    RUNPOD_PROVIDER: "mock",
    WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
    RUNPOD_POOL_MAX_WORKERS: String(workerCount),
    RUNPOD_WORKERS_JSON: JSON.stringify(Array.from({ length: workerCount }, (_, index) => ({
      id: `worker-${index + 1}`,
      pod_id: `pod-${index + 1}`,
      name: `Worker ${index + 1}`,
      service_url: `https://pod-${index + 1}-8000.proxy.runpod.net`,
      model_id: modelId,
      runtime: "realtime",
      max_sessions: maxSessions,
      enabled: true,
    }))),
  });
}

function createProvisioningConfig(timeoutSeconds = 10, autoStopIdle = false) {
  return loadConfig({
    NODE_ENV: "test",
    RUNPOD_PROVIDER: "mock",
    WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
    RUNPOD_POOL_MAX_WORKERS: "1",
    RUNPOD_NETWORK_VOLUME_ID: "shared-model-volume",
    RUNPOD_AUTO_STOP_IDLE: autoStopIdle ? "true" : "false",
    WORKER_PROVISION_TIMEOUT_SECONDS: String(timeoutSeconds),
    RUNPOD_WORKERS_JSON: JSON.stringify([{
      id: "static-disabled",
      pod_id: "pod-static-disabled",
      name: "Disabled static worker",
      service_url: "https://pod-static-disabled-8000.proxy.runpod.net",
      model_id: modelId,
      runtime: "realtime",
      max_sessions: 32,
      enabled: false,
    }]),
    RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
      model_id: modelId,
      runtime: "realtime",
      template_id: "template-realtime",
      max_sessions: 32,
    }]),
  });
}

function createBatchProvisioningConfig() {
  return loadConfig({
    NODE_ENV: "test",
    RUNPOD_PROVIDER: "mock",
    WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
    RUNPOD_POOL_MAX_WORKERS: "1",
    RUNPOD_WORKERS_JSON: "[]",
    RUNPOD_MODEL_TEMPLATES_JSON: JSON.stringify([{
      model_id: finalModelId,
      runtime: "batch",
      template_id: "template-batch",
      max_sessions: 1,
    }]),
  });
}

function createHybridConfig() {
  return loadConfig({
    NODE_ENV: "test",
    RUNPOD_PROVIDER: "mock",
    WORKER_TICKET_SECRET: "worker-ticket-secret-at-least-32-characters",
    RUNPOD_POOL_MAX_WORKERS: "2",
    RUNPOD_WORKERS_JSON: JSON.stringify([
      {
        id: "hybrid-realtime",
        pod_id: "pod-hybrid-realtime",
        name: "Hybrid realtime worker",
        service_url: "https://pod-hybrid-realtime-8000.proxy.runpod.net",
        model_id: modelId,
        runtime: "realtime",
        max_sessions: 1,
        enabled: true,
      },
      {
        id: "hybrid-batch",
        pod_id: "pod-hybrid-batch",
        name: "Hybrid finalizer worker",
        service_url: "https://pod-hybrid-batch-8000.proxy.runpod.net",
        model_id: finalModelId,
        runtime: "batch",
        max_sessions: 1,
        enabled: true,
      },
    ]),
  });
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function provisioningWorker(id = "provision-test"): KnownWorkerConfig {
  return {
    id,
    podId: "",
    name: "Provisioning worker",
    serviceUrl: "https://provisioning.invalid",
    modelId,
    runtime: "realtime",
    maxSessions: 32,
    enabled: true,
  };
}

class FakeFleet implements RunPodFleetClient {
  canMutate = true;
  canCreate() { return false; }
  startCalls: string[] = [];
  stopCalls: string[] = [];
  async getPod(podId: string): Promise<PodInfo> { return { id: podId, desiredStatus: "RUNNING" }; }
  async findPodByWorkerId(workerId: string): Promise<PodInfo | null> {
    void workerId;
    return null;
  }
  async startPod(podId: string) { this.startCalls.push(podId); }
  async stopPod(podId: string) { this.stopCalls.push(podId); }
  async createPod(input: CreateRunPodInput): Promise<PodInfo> {
    void input;
    throw new Error("not supported");
  }
}

class BlockingStartFleet extends FakeFleet {
  startEntered = createGate();
  allowStart = createGate();

  override async getPod(podId: string): Promise<PodInfo> {
    return { id: podId, desiredStatus: "EXITED" };
  }

  override async startPod(podId: string) {
    this.startCalls.push(podId);
    this.startEntered.release();
    await this.allowStart.promise;
  }
}

class CreatingFleet extends FakeFleet {
  createCalls: CreateRunPodInput[] = [];
  createEntered = createGate();
  allowCreate: ReturnType<typeof createGate> | null = null;

  canCreate() { return true; }

  async createPod(input: CreateRunPodInput): Promise<PodInfo> {
    this.createCalls.push(input);
    this.createEntered.release();
    await this.allowCreate?.promise;
    return { id: "pod-created", name: "Created worker", desiredStatus: "RUNNING" };
  }
}

class DiscoveringFleet extends CreatingFleet {
  findCalls: string[] = [];
  discoveries: Array<PodInfo | null | Error> = [];

  override async findPodByWorkerId(workerId: string): Promise<PodInfo | null> {
    this.findCalls.push(workerId);
    const result = this.discoveries.shift() ?? null;
    if (result instanceof Error) throw result;
    return result;
  }
}

class BarrierStore extends MemoryWorkerPoolStore {
  private claimArrivals = 0;
  private bothClaimsArrived = createGate();

  async claimProvisioningWorker(worker: KnownWorkerConfig, poolMaxWorkers: number, now: Date) {
    this.claimArrivals += 1;
    if (this.claimArrivals === 2) this.bothClaimsArrived.release();
    await this.bothClaimsArrived.promise;
    return await super.claimProvisioningWorker(worker, poolMaxWorkers, now);
  }
}

class ReleaseBeforeFirstBindingStore extends MemoryWorkerPoolStore {
  private released = false;

  constructor(private sessionId: string) {
    super();
  }

  override async markProvisioning(
    assignmentId: string,
    workerId: string | null,
    message: string,
    now: Date,
    leaseSeconds: number,
  ) {
    if (!this.released) {
      this.released = true;
      await super.release(this.sessionId, now);
    }
    return await super.markProvisioning(assignmentId, workerId, message, now, leaseSeconds);
  }
}

class LateBindingReleaseStore extends MemoryWorkerPoolStore {
  releaseEntered = createGate();
  allowRelease = createGate();

  override async release(sessionId: string, now: Date) {
    this.releaseEntered.release();
    await this.allowRelease.promise;
    return await super.release(sessionId, now);
  }
}

class RejectingFinalizeStore extends MemoryWorkerPoolStore {
  override async finalizeProvisioningWorker() { return null; }
}

class VanishingWorkerStore extends MemoryWorkerPoolStore {
  vanishedWorkerId: string | null = null;
  readsBeforeVanish = 0;

  override async getWorker(id: string) {
    if (id === this.vanishedWorkerId) {
      if (this.readsBeforeVanish <= 0) return null;
      this.readsBeforeVanish -= 1;
    }
    return await super.getWorker(id);
  }
}

class FakeAdmin implements WorkerAdminClient {
  loadCalls: Array<{ workerId: string; modelId: string }> = [];
  drainCalls: string[] = [];
  probeCalls = 0;
  async probe(worker: WorkerRecord): Promise<WorkerProbe> {
    this.probeCalls += 1;
    return {
      ready: true,
      workerId: worker.id,
      modelId: worker.modelId,
      health: { accelerator: "A100", worker_id: worker.id, model_id: worker.modelId },
    };
  }
  async loadModel(worker: WorkerRecord, nextModelId: string) { this.loadCalls.push({ workerId: worker.id, modelId: nextModelId }); }
  async unloadModel() {}
  async drain(worker: WorkerRecord) { this.drainCalls.push(worker.id); }
}

class SelectiveAdmin extends FakeAdmin {
  unavailableWorkerId: string | null = null;

  override async probe(worker: WorkerRecord): Promise<WorkerProbe> {
    if (worker.id !== this.unavailableWorkerId) return await super.probe(worker);
    this.probeCalls += 1;
    return {
      ready: false,
      workerId: worker.id,
      modelId: worker.modelId,
      message: "worker unavailable",
      health: { worker_id: worker.id, model_id: worker.modelId, message: "worker unavailable" },
    };
  }
}

class BlockingAdmin extends FakeAdmin {
  drainEntered = createGate();
  allowDrain = createGate();

  async drain() {
    this.drainEntered.release();
    await this.allowDrain.promise;
  }
}

class CapacityFullAdmin extends FakeAdmin {
  override async probe(): Promise<WorkerProbe> {
    this.probeCalls += 1;
    return {
      ready: false,
      operational: true,
      atCapacity: true,
      reportedActiveSessions: 1,
      reportedMaxSessions: 1,
      health: {
        worker_id: "worker-1",
        model_id: modelId,
        model_loaded: true,
        model_match: true,
        accepting_sessions: false,
        active_sessions: 1,
        max_sessions: 1,
      },
      workerId: "worker-1",
      modelId,
    };
  }
}

describe("worker scheduler", () => {
  it("selects the least-loaded compatible worker and is idempotent per session", async () => {
    const config = createConfig(2, 2);
    const store = new MemoryWorkerPoolStore();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), new FakeAdmin(), () => 10_000);

    const first = await scheduler.request({ sessionId: "00000000-0000-4000-8000-000000000001", modelId, purpose: "realtime" });
    const retried = await scheduler.request({ sessionId: first.sessionId, modelId, purpose: "realtime" });
    const second = await scheduler.request({ sessionId: "00000000-0000-4000-8000-000000000002", modelId, purpose: "realtime" });

    expect(first.status).toBe("ready");
    expect(retried.id).toBe(first.id);
    expect(first.workerId).toBe("worker-1");
    expect(second.workerId).toBe("worker-2");
    expect(await scheduler.diagnostics()).toMatchObject({
      active_sessions: 2,
      active_assignments: 2,
    });
  });

  it("isolates hybrid purposes when one assigned worker becomes unavailable", async () => {
    const config = createHybridConfig();
    const store = new MemoryWorkerPoolStore();
    const admin = new SelectiveAdmin();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), admin, () => 10_000);
    const sessionId = "00000000-0000-4000-8000-000000000091";

    const realtime = await scheduler.request({ sessionId, modelId, purpose: "realtime" });
    const batch = await scheduler.request({ sessionId, modelId: finalModelId, purpose: "batch" });
    expect(realtime).toMatchObject({ status: "ready", workerId: "hybrid-realtime" });
    expect(batch).toMatchObject({ status: "ready", workerId: "hybrid-batch" });

    admin.unavailableWorkerId = "hybrid-realtime";
    await expect(scheduler.request({ sessionId, modelId, purpose: "realtime" }))
      .resolves.toMatchObject({ status: "provisioning", workerId: null });

    expect(await scheduler.observe(sessionId, "batch")).toMatchObject({
      id: batch.id,
      status: "ready",
      workerId: "hybrid-batch",
    });
    expect(await store.getWorker("hybrid-realtime")).toMatchObject({ activeSessions: 0 });
    expect(await store.getWorker("hybrid-batch")).toMatchObject({ activeSessions: 1 });
    expect(await scheduler.diagnostics()).toMatchObject({
      active_sessions: 1,
      active_assignments: 1,
    });
  });

  it("reassigns a live assignment when its worker is lost without leaking capacity", async () => {
    const config = createConfig(1, 2);
    const store = new MemoryWorkerPoolStore();
    const admin = new SelectiveAdmin();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), admin, () => 10_000);
    const sessionId = "00000000-0000-4000-8000-000000000092";
    const first = await scheduler.request({ sessionId, modelId, purpose: "realtime" });
    await scheduler.touch(sessionId, "realtime");
    expect(first).toMatchObject({ status: "ready", workerId: "worker-1" });

    admin.unavailableWorkerId = "worker-1";
    const reassigned = await scheduler.request({ sessionId, modelId, purpose: "realtime" });

    expect(reassigned).toMatchObject({
      id: first.id,
      status: "ready",
      workerId: "worker-2",
    });
    expect(await store.getWorker("worker-1")).toMatchObject({ status: "unhealthy", activeSessions: 0 });
    expect(await store.getWorker("worker-2")).toMatchObject({ status: "ready", activeSessions: 1 });
    expect(await scheduler.response(reassigned)).toMatchObject({
      worker: { id: "worker-2", active_sessions: 1 },
      connection: { websocket_url: "wss://pod-2-8000.proxy.runpod.net/v1/realtime" },
    });
    expect(await scheduler.diagnostics()).toMatchObject({
      active_sessions: 1,
      active_assignments: 1,
    });
  });

  it("requeues by the original worker id when reconciliation can no longer read the worker row", async () => {
    const config = createConfig(1, 2);
    const store = new VanishingWorkerStore();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), new FakeAdmin(), () => 10_000);
    const sessionId = "00000000-0000-4000-8000-000000000093";
    const first = await scheduler.request({ sessionId, modelId, purpose: "realtime" });
    expect(first).toMatchObject({ status: "ready", workerId: "worker-1" });

    store.vanishedWorkerId = "worker-1";
    store.readsBeforeVanish = 1;
    const reassigned = await scheduler.request({ sessionId, modelId, purpose: "realtime" });

    expect(reassigned).toMatchObject({
      id: first.id,
      status: "ready",
      workerId: "worker-2",
    });
    store.vanishedWorkerId = null;
    expect(await store.getWorker("worker-1")).toMatchObject({ activeSessions: 0 });
    expect(await store.getWorker("worker-2")).toMatchObject({ activeSessions: 1 });
  });

  it("enforces hard capacity and releases capacity idempotently", async () => {
    const config = createConfig(1, 1);
    const store = new MemoryWorkerPoolStore();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), new FakeAdmin(), () => 10_000);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    await scheduler.request({ sessionId, modelId, purpose: "realtime" });

    await expect(scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000002",
      modelId,
      purpose: "realtime",
    })).rejects.toMatchObject({ code: "capacity_exceeded", status: 429 } satisfies Partial<ProviderError>);

    await scheduler.release(sessionId);
    await scheduler.release(sessionId);
    expect((await scheduler.diagnostics()).active_sessions).toBe(0);
  });

  it("keeps a capacity-full worker operational without reserving another session", async () => {
    const config = createConfig(1, 1);
    const store = new MemoryWorkerPoolStore();
    const scheduler = new WorkerScheduler(
      config,
      store,
      new FakeFleet(),
      new CapacityFullAdmin(),
      () => 10_000,
    );

    await expect(scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000031",
      modelId,
      purpose: "realtime",
    })).rejects.toMatchObject({ code: "capacity_exceeded", status: 429 } satisfies Partial<ProviderError>);

    expect(await store.getWorker("worker-1")).toMatchObject({
      status: "ready",
      activeSessions: 1,
      maxSessions: 1,
    });
  });

  it("never switches the model of a worker with an active session", async () => {
    const config = createConfig(2, 1);
    const store = new MemoryWorkerPoolStore();
    const admin = new FakeAdmin();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), admin, () => 10_000);
    await scheduler.request({ sessionId: "00000000-0000-4000-8000-000000000001", modelId, purpose: "realtime" });

    await expect(scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000002",
      modelId: "infodeliverailab/another-realtime-model",
      purpose: "realtime",
    })).rejects.toMatchObject({ code: "model_worker_unavailable", status: 503 });
    expect(admin.loadCalls).toEqual([]);
  });

  it("reconciles and stops a configured worker that was seeded with stopped status", async () => {
    const config = createConfig(1, 1);
    const store = new MemoryWorkerPoolStore();
    const fleet = new FakeFleet();
    const admin = new FakeAdmin();
    const scheduler = new WorkerScheduler(config, store, fleet, admin, () => 10_000);

    await scheduler.stopWorker("worker-1");

    expect(admin.drainCalls).toEqual(["worker-1"]);
    expect(fleet.stopCalls).toEqual(["pod-1"]);
    expect(await store.getWorker("worker-1")).toMatchObject({ enabled: true, status: "stopped" });
  });

  it("fails before discovery or creation when a dynamic batch template has no Network Volume", async () => {
    const config = createBatchProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);

    await expect(scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000091",
      modelId: finalModelId,
      purpose: "batch",
    })).rejects.toMatchObject({
      code: "runpod_network_volume_required",
      status: 503,
    } satisfies Partial<ProviderError>);

    expect(fleet.findCalls).toEqual([]);
    expect(fleet.createCalls).toEqual([]);
    expect(await store.listWorkers()).toEqual([]);
  });

  it("creates only one RunPod Pod for concurrent retries of the same assignment", async () => {
    const config = createProvisioningConfig();
    const store = new BarrierStore();
    const fleet = new CreatingFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);
    const input = {
      sessionId: "00000000-0000-4000-8000-000000000011",
      modelId,
      purpose: "realtime" as const,
    };

    const [first, second] = await Promise.all([scheduler.request(input), scheduler.request(input)]);

    expect(fleet.createCalls).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(first.workerId).toBe(second.workerId);
    expect(first.workerId).toMatch(/^provision-/);
    expect(first.status).toBe("provisioning");
    expect(second.status).toBe("provisioning");
    expect(fleet.createCalls[0].name).toBe(`qwen-${first.workerId}`);
  });

  it("adopts an existing Pod by its exact WORKER_ID before creating another", async () => {
    const config = createProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push({
      id: "pod-orphan",
      name: "orphaned-worker",
      desiredStatus: "RUNNING",
    });
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);

    const assignment = await scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000071",
      modelId,
      purpose: "realtime",
    });

    expect(fleet.createCalls).toHaveLength(0);
    expect(fleet.findCalls).toEqual([assignment.workerId]);
    expect(await store.getWorker(assignment.workerId!)).toMatchObject({
      podId: "pod-orphan",
      name: "orphaned-worker",
      enabled: true,
      status: "starting",
    });
  });

  it("reconciles an existing in-flight placeholder after a control-plane restart", async () => {
    const now = new Date(10_000);
    const config = createProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    await store.seedKnownWorkers(config.workers, now);
    const requested = await store.createRequestedAssignment({
      sessionId: "00000000-0000-4000-8000-000000000073",
      modelId,
      purpose: "realtime",
      now,
      leaseSeconds: config.workerLeaseSeconds,
    });
    const workerId = `provision-${requested.id}`;
    await store.claimProvisioningWorker(provisioningWorker(workerId), config.workerPoolMaxWorkers, now);
    await store.markProvisioning(requested.id, workerId, "provisioning", now, config.workerLeaseSeconds);
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push({
      id: "pod-visible-after-restart",
      name: "restart-recovered-worker",
      desiredStatus: "RUNNING",
    });
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now.getTime());

    const assignment = await scheduler.request({
      sessionId: requested.sessionId,
      modelId,
      purpose: "realtime",
    });

    expect(fleet.createCalls).toHaveLength(0);
    expect(fleet.findCalls).toEqual([workerId]);
    expect(assignment).toMatchObject({ status: "provisioning", workerId });
    expect(await store.getWorker(workerId)).toMatchObject({ podId: "pod-visible-after-restart" });
  });

  it("discovers and adopts a Pod after the create response is lost", async () => {
    const config = createProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push(null, {
      id: "pod-created-despite-timeout",
      name: "recovered-worker",
      desiredStatus: "RUNNING",
    });
    fleet.createPod = async (input: CreateRunPodInput) => {
      fleet.createCalls.push(input);
      throw new Error("create response timed out");
    };
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);

    const assignment = await scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000072",
      modelId,
      purpose: "realtime",
    });

    expect(fleet.createCalls).toHaveLength(1);
    expect(fleet.findCalls).toEqual([assignment.workerId, assignment.workerId]);
    expect(fleet.stopCalls).toEqual([]);
    expect(await store.getWorker(assignment.workerId!)).toMatchObject({
      podId: "pod-created-despite-timeout",
      enabled: true,
      status: "starting",
    });
  });

  it("keeps searching after an ambiguous create failure and adopts a delayed Pod without creating twice", async () => {
    let now = 0;
    const config = createProvisioningConfig(10);
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push(null, null, null, null, {
      id: "pod-delayed-visibility",
      name: "delayed-visibility-worker",
      desiredStatus: "RUNNING",
    });
    fleet.createPod = async (input: CreateRunPodInput) => {
      fleet.createCalls.push(input);
      throw new Error("create response timed out");
    };
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);
    const input = {
      sessionId: "00000000-0000-4000-8000-000000000074",
      modelId,
      purpose: "realtime" as const,
    };

    await expect(scheduler.request(input)).rejects.toThrow("create response timed out");
    const pending = await scheduler.observe(input.sessionId);
    expect(pending).toMatchObject({ status: "provisioning" });
    expect(await store.getWorker(pending!.workerId!)).toMatchObject({
      podId: "",
      enabled: true,
      status: "starting",
      health: { provisioning_recovery_pending: true },
    });

    now = 1_000;
    await expect(scheduler.request(input)).resolves.toMatchObject({
      status: "provisioning",
      workerId: pending!.workerId,
    });
    expect(fleet.createCalls).toHaveLength(1);

    now = 5_000;
    await scheduler.reconcile();

    expect(fleet.createCalls).toHaveLength(1);
    expect(fleet.stopCalls).toEqual([]);
    expect(fleet.findCalls).toEqual([
      pending!.workerId,
      pending!.workerId,
      pending!.workerId,
      pending!.workerId,
      pending!.workerId,
    ]);
    expect(await store.getWorker(pending!.workerId!)).toMatchObject({
      podId: "pod-delayed-visibility",
      enabled: true,
      status: "starting",
      health: null,
    });
  });

  it("stops a delayed Pod discovered for a released recovery placeholder", async () => {
    let now = 0;
    const config = createProvisioningConfig(10, true);
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push(null, null, {
      id: "pod-delayed-orphan",
      name: "delayed-orphan-worker",
      desiredStatus: "RUNNING",
    });
    fleet.createPod = async (input: CreateRunPodInput) => {
      fleet.createCalls.push(input);
      throw new Error("create response timed out");
    };
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);
    const sessionId = "00000000-0000-4000-8000-000000000075";

    await expect(scheduler.request({ sessionId, modelId, purpose: "realtime" })).rejects.toThrow(
      "create response timed out",
    );
    const pending = await scheduler.observe(sessionId);
    await scheduler.release(sessionId);

    now = 5_000;
    await scheduler.reapExpired();

    expect(fleet.createCalls).toHaveLength(1);
    expect(fleet.stopCalls).toEqual(["pod-delayed-orphan"]);
    expect(await store.getWorker(pending!.workerId!)).toMatchObject({
      podId: "pod-delayed-orphan",
      enabled: true,
      status: "stopped",
    });
    expect(await scheduler.observe(sessionId)).toMatchObject({ status: "released" });
  });

  it("closes an unresolved recovery placeholder at the provisioning deadline", async () => {
    let now = 0;
    const config = createProvisioningConfig(10);
    const store = new MemoryWorkerPoolStore();
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push(null, null, null);
    fleet.createPod = async (input: CreateRunPodInput) => {
      fleet.createCalls.push(input);
      throw new Error("create response timed out");
    };
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);
    const sessionId = "00000000-0000-4000-8000-000000000076";

    await expect(scheduler.request({ sessionId, modelId, purpose: "realtime" })).rejects.toThrow(
      "create response timed out",
    );
    const pending = await scheduler.observe(sessionId);

    now = 10_001;
    await scheduler.reapExpired();

    expect(fleet.createCalls).toHaveLength(1);
    expect(fleet.stopCalls).toEqual([]);
    expect(await store.getWorker(pending!.workerId!)).toMatchObject({
      podId: "",
      enabled: false,
      status: "terminated",
      health: { message: "GPU worker provisioning timed out" },
    });
  });

  it("starts a stopped static Pod only once for concurrent sessions", async () => {
    const config = createConfig(32, 1);
    const store = new MemoryWorkerPoolStore();
    const fleet = new BlockingStartFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);
    const firstPromise = scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000051",
      modelId,
      purpose: "realtime",
    });
    await fleet.startEntered.promise;

    const second = await scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000052",
      modelId,
      purpose: "realtime",
    });

    expect(fleet.startCalls).toEqual(["pod-1"]);
    expect(second).toMatchObject({ status: "provisioning", workerId: "worker-1" });
    fleet.allowStart.release();
    expect(await firstPromise).toMatchObject({ status: "provisioning", workerId: "worker-1" });
  });

  it("provisions one cold Pod for concurrent sessions with the same model and runtime", async () => {
    const config = createProvisioningConfig(10);
    const store = new BarrierStore();
    const fleet = new CreatingFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);

    const [first, second] = await Promise.all([
      scheduler.request({
        sessionId: "00000000-0000-4000-8000-000000000061",
        modelId,
        purpose: "realtime",
      }),
      scheduler.request({
        sessionId: "00000000-0000-4000-8000-000000000062",
        modelId,
        purpose: "realtime",
      }),
    ]);

    expect(fleet.createCalls).toHaveLength(1);
    expect(first.workerId).toBe(second.workerId);
    expect(first.status).toBe("provisioning");
    expect(second.status).toBe("provisioning");
  });

  it("leaves an idle dynamic Pod running when automatic stop is not enabled", async () => {
    const config = createProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    const fleet = new FakeFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 10_000);
    await store.upsertWorker({
      ...provisioningWorker("dynamic-worker"),
      podId: "pod-dynamic",
      serviceUrl: "https://pod-dynamic-8000.proxy.runpod.net",
    }, "ready", new Date(10_000));
    const sessionId = "00000000-0000-4000-8000-000000000020";
    await scheduler.request({ sessionId, modelId, purpose: "realtime" });

    await scheduler.release(sessionId);

    expect(fleet.stopCalls).toEqual([]);
    expect(await store.getWorker("dynamic-worker")).toMatchObject({
      activeSessions: 0,
      enabled: true,
      status: "ready",
    });
  });

  it("does not assign a session after an idle worker has been claimed for draining", async () => {
    const config = createProvisioningConfig(10, true);
    const store = new MemoryWorkerPoolStore();
    const fleet = new FakeFleet();
    const admin = new BlockingAdmin();
    const scheduler = new WorkerScheduler(config, store, fleet, admin, () => 10_000);
    await store.upsertWorker({
      ...provisioningWorker("dynamic-worker"),
      podId: "pod-dynamic",
      serviceUrl: "https://pod-dynamic-8000.proxy.runpod.net",
    }, "ready", new Date(10_000));
    const firstSessionId = "00000000-0000-4000-8000-000000000021";
    await scheduler.request({ sessionId: firstSessionId, modelId, purpose: "realtime" });

    const releasePromise = scheduler.release(firstSessionId);
    await admin.drainEntered.promise;
    const secondError = await scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000022",
      modelId,
      purpose: "realtime",
    }).then(() => null, (error: unknown) => error);

    expect(secondError).toMatchObject({ code: "model_worker_unavailable", status: 503 });
    admin.allowDrain.release();
    await releasePromise;
    expect(fleet.stopCalls).toEqual(["pod-dynamic"]);
    expect(await store.getWorker("dynamic-worker")).toMatchObject({ enabled: true, status: "stopped" });
  });

  it("adopts an orphaned in-flight Pod during scheduled reconciliation without a client retry", async () => {
    const config = createProvisioningConfig();
    const store = new MemoryWorkerPoolStore();
    await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(0));
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push({
      id: "pod-scheduled-recovery",
      name: "scheduled-recovery",
      desiredStatus: "RUNNING",
    });
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 5_000);

    await scheduler.reconcile();

    expect(fleet.createCalls).toHaveLength(0);
    expect(fleet.findCalls).toEqual(["provision-test"]);
    expect(await store.getWorker("provision-test")).toMatchObject({
      podId: "pod-scheduled-recovery",
      enabled: true,
      status: "starting",
    });
  });

  it("adopts and stops an unassigned orphan before the provisioning reaper can forget it", async () => {
    let now = 0;
    const config = createProvisioningConfig(10, true);
    const store = new MemoryWorkerPoolStore();
    await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(now));
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push({
      id: "pod-reaper-recovery",
      name: "reaper-recovery",
      desiredStatus: "RUNNING",
    });
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);

    now = 10_001;
    await scheduler.reapExpired();

    expect(fleet.findCalls).toEqual(["provision-test"]);
    expect(fleet.stopCalls).toEqual(["pod-reaper-recovery"]);
    expect(await store.getWorker("provision-test")).toMatchObject({
      podId: "pod-reaper-recovery",
      enabled: true,
      status: "stopped",
    });
  });

  it("fails loudly and preserves the placeholder when scheduled discovery finds duplicate Pods", async () => {
    let now = 0;
    const config = createProvisioningConfig(10);
    const store = new MemoryWorkerPoolStore();
    await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(now));
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push(new ProviderError(
      "runpod_duplicate_worker_pods",
      "duplicate worker identity",
      502,
    ));
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);

    now = 10_001;
    await expect(scheduler.reapExpired()).rejects.toMatchObject({
      code: "runpod_duplicate_worker_pods",
      status: 502,
    });

    expect(fleet.stopCalls).toEqual([]);
    expect(await store.getWorker("provision-test")).toMatchObject({
      podId: "",
      enabled: true,
      status: "starting",
    });
  });

  it("stops a discovered orphan when it cannot be registered", async () => {
    const config = createProvisioningConfig();
    const store = new RejectingFinalizeStore();
    await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(0));
    const fleet = new DiscoveringFleet();
    fleet.discoveries.push({
      id: "pod-registration-rejected",
      name: "registration-rejected",
      desiredStatus: "RUNNING",
    });
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 5_000);

    await expect(scheduler.reconcile()).rejects.toMatchObject({
      code: "worker_registry_failed",
      status: 503,
    });

    expect(fleet.stopCalls).toEqual(["pod-registration-rejected"]);
  });

  it("does not refresh an empty provisioning placeholder and reaps it after the deadline", async () => {
    let now = 0;
    const config = createProvisioningConfig(10);
    const store = new MemoryWorkerPoolStore();
    await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(now));
    const admin = new FakeAdmin();
    const scheduler = new WorkerScheduler(config, store, new FakeFleet(), admin, () => now);

    now = 5_000;
    await scheduler.reconcile();
    expect(admin.probeCalls).toBe(0);
    expect((await store.getWorker("provision-test"))?.updatedAt.getTime()).toBe(0);

    now = 10_001;
    await scheduler.reapExpired();
    expect(await store.getWorker("provision-test")).toMatchObject({
      enabled: false,
      status: "terminated",
      podId: "",
    });
    expect(await store.claimProvisioningWorker(provisioningWorker(), 1, new Date(now + 1))).toMatchObject({
      acquired: true,
      worker: { enabled: true, status: "starting" },
    });
  });

  it("stops a Pod whose create response arrives after its placeholder deadline", async () => {
    let now = 0;
    const config = createProvisioningConfig(10);
    const store = new MemoryWorkerPoolStore();
    const fleet = new CreatingFleet();
    fleet.allowCreate = createGate();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => now);
    const requestResult = scheduler.request({
      sessionId: "00000000-0000-4000-8000-000000000031",
      modelId,
      purpose: "realtime",
    }).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    await fleet.createEntered.promise;

    now = 10_001;
    await scheduler.reapExpired();
    fleet.allowCreate.release();
    const result = await requestResult;

    expect(result.error).toMatchObject({ code: "worker_registry_failed", status: 503 });
    expect(fleet.stopCalls).toEqual(["pod-created"]);
    const dynamicWorker = (await store.listWorkers()).find((worker) => worker.origin === "dynamic");
    expect(dynamicWorker).toMatchObject({ enabled: false, status: "terminated", podId: "" });
  });

  it.each([
    [true, ["pod-created"]],
    [false, []],
  ])(
    "handles a Pod whose create response arrives after session release (auto-stop=%s)",
    async (autoStopIdle, expectedStops) => {
      const config = createProvisioningConfig(10, autoStopIdle);
      const store = new MemoryWorkerPoolStore();
      const fleet = new CreatingFleet();
      fleet.allowCreate = createGate();
      const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 0);
      const sessionId = autoStopIdle
        ? "00000000-0000-4000-8000-000000000041"
        : "00000000-0000-4000-8000-000000000042";
      const pending = scheduler.request({ sessionId, modelId, purpose: "realtime" });
      await fleet.createEntered.promise;

      await scheduler.release(sessionId);
      fleet.allowCreate.release();
      const assignment = await pending;

      expect(assignment.status).toBe("released");
      expect(fleet.stopCalls).toEqual(expectedStops);
      const dynamicWorker = (await store.listWorkers()).find((worker) => worker.origin === "dynamic");
      expect(dynamicWorker).toMatchObject({
        podId: "pod-created",
        status: autoStopIdle ? "stopped" : "starting",
        enabled: true,
      });
    },
  );

  it("does not call RunPod after an assignment is released before cold provisioning binds", async () => {
    const config = createProvisioningConfig();
    const sessionId = "00000000-0000-4000-8000-000000000043";
    const store = new ReleaseBeforeFirstBindingStore(sessionId);
    const fleet = new DiscoveringFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 0);

    const assignment = await scheduler.request({ sessionId, modelId, purpose: "realtime" });

    expect(assignment.status).toBe("released");
    expect(fleet.findCalls).toEqual([]);
    expect(fleet.createCalls).toEqual([]);
    expect(fleet.startCalls).toEqual([]);
    const placeholder = (await store.listWorkers()).find((worker) => worker.origin === "dynamic");
    expect(placeholder).toMatchObject({
      podId: "",
      enabled: false,
      status: "terminated",
    });
  });

  it("uses the release result to stop a worker bound after the pre-release snapshot", async () => {
    const config = createProvisioningConfig(10, true);
    const store = new LateBindingReleaseStore();
    const fleet = new FakeFleet();
    const scheduler = new WorkerScheduler(config, store, fleet, new FakeAdmin(), () => 0);
    const sessionId = "00000000-0000-4000-8000-000000000044";
    const claim = await store.claimProvisioningWorker({
      ...provisioningWorker("late-bound-worker"),
      podId: "",
    }, 1, new Date(0));
    expect(claim?.acquired).toBe(true);
    await store.finalizeProvisioningWorker("late-bound-worker", {
      podId: "pod-late-bound",
      name: "Late bound worker",
      serviceUrl: "https://pod-late-bound-8000.proxy.runpod.net",
    }, new Date(0));
    await store.updateWorker("late-bound-worker", { status: "ready" }, new Date(0));
    const assignment = await store.createRequestedAssignment({
      sessionId,
      modelId,
      purpose: "realtime",
      now: new Date(0),
      leaseSeconds: 900,
    });
    const pendingRelease = scheduler.release(sessionId);
    await store.releaseEntered.promise;
    await store.reserveReadyWorker(assignment.id, new Date(1), 900);

    store.allowRelease.release();
    await pendingRelease;

    expect(fleet.stopCalls).toEqual(["pod-late-bound"]);
    expect(await store.getWorker("late-bound-worker")).toMatchObject({
      activeSessions: 0,
      enabled: true,
      status: "stopped",
    });
  });
});
