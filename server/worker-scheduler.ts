import type { AppConfig } from "./config.js";
import { ProviderError } from "./runpod.js";
import type { PodInfo, PodProvider, AssignmentRecord, WorkerRecord, WorkerRuntime } from "./types.js";
import {
  createFleetClient,
  createWorkerAdminClient,
  type RunPodFleetClient,
  type WorkerAdminClient,
} from "./worker-clients.js";
import { createWorkerPoolStore, type WorkerPoolStore, type WorkerUpdate } from "./worker-store.js";
import { createWorkerTicket } from "./worker-ticket.js";

export interface AssignmentResponse {
  id: string;
  session_id: string;
  model_id: string;
  purpose: WorkerRuntime;
  status: AssignmentRecord["status"];
  worker?: ReturnType<typeof workerSummary>;
  connection?: {
    websocket_url: string;
    batch_url?: string;
    ticket: string;
    expires_at: string;
    catalog_revision: string | null;
  };
  message: string | null;
  retry_after_ms: number | null;
}

function workerSummary(worker: WorkerRecord) {
  const gpuType = typeof worker.gpu?.displayName === "string"
    ? worker.gpu.displayName
    : typeof worker.gpu?.id === "string"
      ? worker.gpu.id
      : typeof worker.health?.accelerator === "string" ? worker.health.accelerator : null;
  return {
    id: worker.id,
    pod_id: worker.podId,
    name: worker.name,
    model_id: worker.modelId,
    loaded_model_id: worker.modelId,
    runtime: worker.runtime,
    status: worker.status,
    active_sessions: worker.activeSessions,
    max_sessions: worker.maxSessions,
    enabled: worker.enabled,
    gpu: worker.gpu,
    gpu_type: gpuType,
    health: worker.health,
    last_heartbeat_at: worker.lastHeartbeatAt?.toISOString() ?? null,
  };
}

export class WorkerScheduler {
  private initialized: Promise<void> | null = null;
  private reconcilePromise: Promise<void> | null = null;

  constructor(
    private config: AppConfig,
    private store: WorkerPoolStore,
    private fleet: RunPodFleetClient,
    private admin: WorkerAdminClient,
    private now: () => number = Date.now,
  ) {}

  private ensureInitialized() {
    this.initialized ??= this.store.seedKnownWorkers(this.config.workers, new Date(this.now()));
    return this.initialized;
  }

  private async updateObservedWorker(worker: WorkerRecord, update: WorkerUpdate, now: Date) {
    return await this.store.updateWorkerIfStatus(worker.id, worker.status, update, now)
      ?? await this.store.getWorker(worker.id);
  }

  private async reconcileWorker(worker: WorkerRecord) {
    const current = await this.store.getWorker(worker.id);
    if (!current || !current.enabled) return current;
    if (current.origin === "dynamic" && !current.podId && current.status === "starting") {
      return await this.findAndRegisterProvisionedWorker(current) ?? current;
    }
    let gpu = current.gpu;
    if (current.podId && this.config.provider !== "readonly") {
      try {
        const pod = await this.fleet.getPod(current.podId);
        gpu = pod.gpu ? { ...pod.gpu } : gpu;
        if (pod.desiredStatus === "TERMINATED") {
          return await this.updateObservedWorker(current, { status: "terminated", enabled: false, gpu }, new Date(this.now()));
        }
        if (pod.desiredStatus === "EXITED") {
          if (current.status === "starting") return current;
          return await this.updateObservedWorker(current, { status: "stopped", gpu }, new Date(this.now()));
        }
      } catch (error) {
        if (this.config.provider === "live") {
          return await this.updateObservedWorker(current, {
            status: "unhealthy",
            health: { message: error instanceof Error ? error.message : "RunPod unavailable" },
          }, new Date(this.now()));
        }
      }
    }
    const probe = await this.admin.probe(current);
    const checkedAt = new Date(this.now());
    if (probe.workerId !== current.id) {
      return await this.updateObservedWorker(current, {
        status: "unhealthy",
        gpu,
        health: { ...probe.health, message: `worker identity missing or mismatched: expected ${current.id}` },
        lastHeartbeatAt: checkedAt,
      }, checkedAt);
    }
    if (probe.modelId !== current.modelId) {
      return await this.updateObservedWorker(current, {
        status: "unhealthy",
        gpu,
        health: { ...probe.health, message: `worker model missing or mismatched: expected ${current.modelId}` },
        lastHeartbeatAt: checkedAt,
      }, checkedAt);
    }
    if (probe.ready || probe.operational) {
      const observedMax = probe.reportedMaxSessions;
      const capacityUpdate = probe.atCapacity && observedMax !== undefined
        ? {
            maxSessions: Math.min(current.maxSessions, observedMax),
            activeSessions: Math.max(
              current.activeSessions,
              Math.min(current.maxSessions, observedMax),
              probe.reportedActiveSessions ?? 0,
            ),
          }
        : {};
      return await this.updateObservedWorker(current, {
        status: "ready",
        gpu,
        health: probe.health ?? null,
        lastHeartbeatAt: checkedAt,
        ...capacityUpdate,
      }, checkedAt);
    }
    const status = probe.health?.draining === true
      ? "draining"
      : current.status === "starting" || current.status === "loading" ? current.status : "unhealthy";
    return await this.updateObservedWorker(current, {
      status,
      gpu,
      health: probe.health ?? (probe.message ? { message: probe.message } : null),
      lastHeartbeatAt: checkedAt,
    }, checkedAt);
  }

  async reconcile() {
    await this.ensureInitialized();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      const workers = await this.store.listWorkers();
      await Promise.all(workers.filter((worker) => worker.enabled).map((worker) => this.reconcileWorker(worker)));
    })().finally(() => { this.reconcilePromise = null; });
    return this.reconcilePromise;
  }

  private async reserve(assignment: AssignmentRecord) {
    return await this.store.reserveReadyWorker(assignment.id, new Date(this.now()), this.config.workerLeaseSeconds);
  }

  private async registerProvisionedWorker(
    workerId: string,
    pod: PodInfo,
  ) {
    if (!pod.id) {
      throw new ProviderError("runpod_api_invalid_response", "RunPod API did not return a Pod ID", 502);
    }
    const finalized = await this.store.finalizeProvisioningWorker(workerId, {
      podId: pod.id,
      name: pod.name || `qwen-${workerId}`,
      serviceUrl: `https://${pod.id}-${this.config.workerPort}.proxy.runpod.net`,
    }, new Date(this.now()));
    const current = finalized ?? await this.store.getWorker(workerId);
    const dynamicWorker = current?.enabled
      && current.origin === "dynamic"
      && current.podId === pod.id
      ? current
      : null;
    if (!dynamicWorker) {
      throw new ProviderError("worker_registry_failed", "Created GPU worker could not be registered", 503);
    }
    if (pod.desiredStatus === "EXITED" && dynamicWorker.status === "starting") {
      return await this.store.updateWorkerIfStatus(dynamicWorker.id, "starting", {
        status: "stopped",
      }, new Date(this.now())) ?? dynamicWorker;
    }
    return dynamicWorker;
  }

  private logPodAdoption(workerId: string, podId: string) {
    console.info(JSON.stringify({
      level: "info",
      event: "runpod_worker_adopted",
      workerId,
      podId,
    }));
  }

  private async findAndRegisterProvisionedWorker(worker: WorkerRecord) {
    if (worker.origin !== "dynamic" || worker.podId || worker.status !== "starting") return null;
    const pod = await this.fleet.findPodByWorkerId(worker.id);
    if (!pod) return null;
    try {
      const dynamicWorker = await this.registerProvisionedWorker(worker.id, pod);
      this.logPodAdoption(worker.id, pod.id);
      return dynamicWorker;
    } catch (error) {
      try {
        await this.fleet.stopPod(pod.id);
        console.warn(JSON.stringify({
          level: "warn",
          event: "unregistered_orphan_pod_stopped",
          workerId: worker.id,
          podId: pod.id,
        }));
      } catch (stopError) {
        console.error(JSON.stringify({
          level: "error",
          event: "provisioning_billing_guard_failed",
          workerId: worker.id,
          podId: pod.id,
          message: stopError instanceof Error ? stopError.message : "unknown error",
        }));
      }
      throw error;
    }
  }

  private async registerProvisionedPod(
    assignment: AssignmentRecord,
    workerId: string,
    pod: PodInfo,
    message: string,
  ) {
    const dynamicWorker = await this.registerProvisionedWorker(workerId, pod);
    return await this.store.markProvisioning(
      assignment.id,
      dynamicWorker.id,
      message,
      new Date(this.now()),
      this.config.workerLeaseSeconds,
    );
  }

  private async adoptProvisionedPod(assignment: AssignmentRecord, worker: WorkerRecord) {
    const dynamicWorker = await this.findAndRegisterProvisionedWorker(worker);
    if (!dynamicWorker) return null;
    return await this.store.markProvisioning(
      assignment.id,
      dynamicWorker.id,
      "既存のRunPod GPUワーカーを復旧しています",
      new Date(this.now()),
      this.config.workerLeaseSeconds,
    );
  }

  private async startStoppedWorker(worker: WorkerRecord) {
    const claimed = await this.store.claimStoppedWorkerForStart(worker.id, new Date(this.now()));
    if (!claimed) return await this.store.getWorker(worker.id);
    try {
      await this.fleet.startPod(claimed.podId);
      return claimed;
    } catch (error) {
      await this.store.updateWorkerIfStatus(claimed.id, "starting", {
        status: "unhealthy",
        health: { message: error instanceof Error ? error.message : "RunPod start failed" },
      }, new Date(this.now()));
      throw error;
    }
  }

  private async stopDynamicWorkerIfIdle(workerId: string) {
    if (!this.fleet.canMutate) return;
    const worker = await this.store.getWorker(workerId);
    if (
      worker?.origin !== "dynamic"
      || !worker.podId
      || !worker.enabled
      || ["stopped", "terminated"].includes(worker.status)
    ) return;
    const claimed = await this.store.claimIdleWorkerForDrain(worker.id, new Date(this.now()));
    if (!claimed) return;
    try { await this.admin.drain(claimed); } catch { /* a starting worker may not expose admin yet */ }
    try {
      await this.fleet.stopPod(claimed.podId);
      await this.store.updateWorker(claimed.id, { status: "stopped", enabled: true }, new Date(this.now()));
    } catch (error) {
      await this.store.updateWorker(claimed.id, {
        status: "unhealthy",
        enabled: false,
        health: { message: "GPU worker stop failed" },
      }, new Date(this.now()));
      console.error(JSON.stringify({
        level: "error",
        event: "dynamic_worker_stop_failed",
        workerId: claimed.id,
        message: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }

  private async progress(initial: AssignmentRecord): Promise<AssignmentRecord> {
    if (["released", "failed"].includes(initial.status)) return initial;
    if (initial.status === "active") return initial;
    if (initial.status === "ready") {
      const worker = initial.workerId ? await this.store.getWorker(initial.workerId) : null;
      const observed = worker ? await this.reconcileWorker(worker) : null;
      if (observed?.enabled && observed.status === "ready" && observed.modelId === initial.modelId) return initial;
      await this.store.release(initial.sessionId, new Date(this.now()));
      return await this.store.markFailed(initial.id, "割り当て済みGPUワーカーが利用できなくなりました", new Date(this.now()));
    }
    let assignment = await this.reserve(initial);
    if (assignment.status === "ready") return assignment;

    if (assignment.workerId) {
      const assignedWorker = await this.store.getWorker(assignment.workerId);
      if (assignedWorker) {
        const adopted = await this.adoptProvisionedPod(assignment, assignedWorker);
        if (adopted) return adopted;
        let observed = await this.reconcileWorker(assignedWorker);
        assignment = await this.reserve(assignment);
        if (assignment.status === "ready") return assignment;
        if (observed?.status === "stopped" && observed.podId && this.fleet.canMutate) {
          observed = await this.startStoppedWorker(observed);
        }
        if (observed?.status !== "terminated") {
          return await this.store.markProvisioning(
            assignment.id,
            assignedWorker.id,
            observed?.status === "loading" ? "モデルをGPUへロードしています" : "GPUワーカーを起動しています",
            new Date(this.now()),
            this.config.workerLeaseSeconds,
          );
        }
        assignment = await this.store.markProvisioning(
          assignment.id,
          null,
          "終了したGPUワーカーの代替を探しています",
          new Date(this.now()),
          this.config.workerLeaseSeconds,
        );
      }
    }

    let workers = await this.store.listWorkers();
    const compatible = workers.filter((worker) => worker.enabled && worker.modelId === assignment.modelId && worker.runtime === assignment.purpose);
    const observedCompatible = (await Promise.all(compatible
      .filter((worker) => worker.status !== "ready" || worker.activeSessions < worker.maxSessions)
      .map((worker) => this.reconcileWorker(worker))))
      .filter((worker): worker is WorkerRecord => Boolean(worker));
    assignment = await this.reserve(assignment);
    if (assignment.status === "ready") return assignment;
    for (const observed of observedCompatible) {
      if (observed?.status === "stopped" && observed.podId && this.fleet.canMutate) {
        const starting = await this.startStoppedWorker(observed);
        assignment = await this.reserve(assignment);
        if (assignment.status === "ready") return assignment;
        if (
          starting?.enabled
          && starting.modelId === assignment.modelId
          && starting.runtime === assignment.purpose
          && ["starting", "loading", "unhealthy", "ready"].includes(starting.status)
        ) {
          return await this.store.markProvisioning(
            assignment.id,
            starting.id,
            "GPUワーカーを起動しています",
            new Date(this.now()),
            this.config.workerLeaseSeconds,
          );
        }
      }
      if (observed.status === "starting" || observed.status === "loading" || observed.status === "unhealthy") {
        return await this.store.markProvisioning(
          assignment.id,
          observed.id,
          observed.status === "loading" ? "モデルをGPUへロードしています" : "GPUワーカーの準備を待っています",
          new Date(this.now()),
          this.config.workerLeaseSeconds,
        );
      }
    }

    workers = await this.store.listWorkers();
    let enabledCount = workers.filter((worker) => worker.enabled).length;
    const canCreate = this.fleet.canCreate(assignment.modelId, assignment.purpose);
    if (canCreate && enabledCount < this.config.workerPoolMaxWorkers) {
      const profile = this.config.modelTemplates.find((candidate) => (
        candidate.modelId === assignment.modelId && candidate.runtime === assignment.purpose
      ));
      const workerId = `provision-${assignment.id}`;
      const claim = await this.store.claimProvisioningWorker({
        id: workerId,
        podId: "",
        name: `qwen-${workerId}`,
        serviceUrl: "https://provisioning.invalid",
        modelId: assignment.modelId,
        runtime: assignment.purpose,
        maxSessions: profile?.maxSessions ?? (assignment.purpose === "realtime" ? 32 : 1),
        enabled: true,
      }, this.config.workerPoolMaxWorkers, new Date(this.now()));
      if (claim?.acquired) {
        const claimed = claim.worker;
        // Bind the assignment to the placeholder before touching RunPod. A create
        // request can succeed remotely while its response is lost, so the
        // placeholder must remain discoverable (and non-reusable) until the
        // provisioning deadline.
        await this.store.markProvisioning(
          assignment.id,
          claimed.id,
          "RunPod GPU worker provisioning is in progress",
          new Date(this.now()),
          this.config.workerLeaseSeconds,
        );
        let createdPodId: string | null = null;
        let createAttempted = false;
        try {
          const existingPod = await this.fleet.findPodByWorkerId(workerId);
          if (existingPod) {
            createdPodId = existingPod.id;
            const adopted = await this.registerProvisionedPod(
              assignment,
              claimed.id,
              existingPod,
              "既存のRunPod GPUワーカーを復旧しています",
            );
            this.logPodAdoption(claimed.id, existingPod.id);
            return adopted;
          }
          createAttempted = true;
          const created = await this.fleet.createPod({
            name: `qwen-${workerId}`,
            workerId,
            modelId: assignment.modelId,
            runtime: assignment.purpose,
          });
          createdPodId = created.id;
          return await this.registerProvisionedPod(
            assignment,
            claimed.id,
            created,
            "新しいRunPod GPUワーカーを作成しています",
          );
        } catch (error) {
          let failure = error;
          if (createAttempted && !createdPodId) {
            try {
              const recovered = await this.fleet.findPodByWorkerId(workerId);
              if (recovered) {
                createdPodId = recovered.id;
                const adopted = await this.registerProvisionedPod(
                  assignment,
                  claimed.id,
                  recovered,
                  "作成済みのRunPod GPUワーカーを復旧しています",
                );
                this.logPodAdoption(claimed.id, recovered.id);
                return adopted;
              }
            } catch (recoveryError) {
              failure = recoveryError;
            }
          }
          let stoppedCreatedPod = false;
          if (createdPodId) {
            try {
              await this.fleet.stopPod(createdPodId);
              stoppedCreatedPod = true;
            } catch (stopError) {
              console.error(JSON.stringify({
                level: "error",
                event: "provisioning_billing_guard_failed",
                workerId: claimed.id,
                podId: createdPodId,
                message: stopError instanceof Error ? stopError.message : "unknown error",
              }));
            }
          }
          const failureMessage = failure instanceof Error ? failure.message : "GPU worker provisioning failed";
          if (!createdPodId) {
            const current = await this.store.getWorker(claimed.id);
            if (
              current?.enabled
              && current.origin === "dynamic"
              && current.status === "starting"
              && !current.podId
            ) {
              await this.store.updateWorkerIfStatus(claimed.id, "starting", {
                health: {
                  message: failureMessage,
                  provisioning_recovery_pending: true,
                },
              }, new Date(this.now()));
            }
          } else {
            await this.store.updateWorker(claimed.id, {
              enabled: false,
              status: "terminated",
              health: { message: failureMessage },
              ...(stoppedCreatedPod
                ? { podId: "", serviceUrl: "https://provisioning.invalid" }
                : {
                    podId: createdPodId,
                    serviceUrl: `https://${createdPodId}-${this.config.workerPort}.proxy.runpod.net`,
                  }),
            }, new Date(this.now()));
          }
          throw failure;
        }
      } else if (claim) {
        const adopted = await this.adoptProvisionedPod(assignment, claim.worker);
        if (adopted) return adopted;
        return await this.store.markProvisioning(
          assignment.id,
          claim.worker.id,
          "新しいGPUワーカーを作成しています",
          new Date(this.now()),
          this.config.workerLeaseSeconds,
        );
      } else {
        const inFlight = await this.store.getWorker(workerId);
        if (
          inFlight?.enabled
          && inFlight.origin === "dynamic"
          && inFlight.modelId === assignment.modelId
          && inFlight.runtime === assignment.purpose
          && ["starting", "loading", "unhealthy", "ready"].includes(inFlight.status)
        ) {
          const adopted = await this.adoptProvisionedPod(assignment, inFlight);
          if (adopted) return adopted;
          return await this.store.markProvisioning(
            assignment.id,
            inFlight.id,
            "新しいGPUワーカーを作成しています",
            new Date(this.now()),
            this.config.workerLeaseSeconds,
          );
        }
      }
      workers = await this.store.listWorkers();
      enabledCount = workers.filter((worker) => worker.enabled).length;
    }

    if (!compatible.length && !canCreate) {
      throw new ProviderError("model_worker_unavailable", "このモデルを実行できるGPUワーカーが登録されていません", 503);
    }
    const atHardCapacity = enabledCount >= this.config.workerPoolMaxWorkers
      && workers.filter((worker) => worker.enabled).every((worker) => (
        worker.activeSessions >= worker.maxSessions
        || worker.runtime !== assignment.purpose
        || worker.modelId !== assignment.modelId
      ));
    if (atHardCapacity) throw new ProviderError("capacity_exceeded", "利用可能なGPUワーカー容量がありません", 429);
    return await this.store.markProvisioning(
      assignment.id,
      null,
      this.fleet.canMutate ? "利用可能なGPUワーカーを待っています" : "RunPod GPUの手動起動を待っています",
      new Date(this.now()),
      this.config.workerLeaseSeconds,
    );
  }

  async request(input: { sessionId: string; modelId: string; purpose: WorkerRuntime }) {
    await this.ensureInitialized();
    const existing = await this.store.getAssignmentBySession(input.sessionId);
    if (existing) return await this.progress(existing);
    const assignment = await this.store.createRequestedAssignment({
      ...input,
      now: new Date(this.now()),
      leaseSeconds: this.config.workerLeaseSeconds,
    });
    return await this.progress(assignment);
  }

  async observe(sessionId: string) {
    await this.ensureInitialized();
    return await this.store.getAssignmentBySession(sessionId);
  }

  async touch(sessionId: string) {
    await this.ensureInitialized();
    return await this.store.touch(sessionId, new Date(this.now()), this.config.workerLeaseSeconds);
  }

  async release(sessionId: string) {
    await this.ensureInitialized();
    const before = await this.store.getAssignmentBySession(sessionId);
    const released = await this.store.release(sessionId, new Date(this.now()));
    if (before?.workerId) await this.stopDynamicWorkerIfIdle(before.workerId);
    return released;
  }

  async reapExpired() {
    await this.ensureInitialized();
    const now = new Date(this.now());
    const workersBeforeReap = await this.store.listWorkers();
    await Promise.all(workersBeforeReap
      .filter((worker) => worker.enabled && worker.origin === "dynamic" && !worker.podId && worker.status === "starting")
      .map((worker) => this.reconcileWorker(worker)));
    const staleProvisioningWorkers = await this.store.reapStaleProvisioningWorkers(
      now,
      this.config.workerProvisionTimeoutSeconds,
    );
    if (staleProvisioningWorkers > 0) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "stale_provisioning_workers_reaped",
        count: staleProvisioningWorkers,
      }));
    }
    const released = await this.store.reapExpired(now);
    const workers = await this.store.listWorkers();
    await Promise.all(workers.filter((worker) => worker.origin === "dynamic").map((worker) => (
      this.stopDynamicWorkerIfIdle(worker.id)
    )));
    return released;
  }

  async diagnostics() {
    await this.ensureInitialized();
    const workers = await this.store.listWorkers();
    const ready = workers.filter((worker) => worker.enabled && worker.status === "ready").length;
    const activeSessions = workers.reduce((total, worker) => total + worker.activeSessions, 0);
    const capacity = workers.filter((worker) => worker.enabled).reduce((total, worker) => total + worker.maxSessions, 0);
    const provisioningAssignments = await this.store.countAssignments(["requested", "provisioning"]);
    return {
      total_workers: workers.length,
      ready_workers: ready,
      active_sessions: activeSessions,
      capacity,
      provisioning_assignments: provisioningAssignments,
      workers: workers.map(workerSummary),
      summary: {
        total: workers.length,
        enabled: workers.filter((worker) => worker.enabled).length,
        ready,
        active_sessions: activeSessions,
        capacity,
        provisioning_assignments: provisioningAssignments,
      },
      checked_at: new Date(this.now()).toISOString(),
    };
  }

  async health() {
    try {
      await this.ensureInitialized();
      return await this.store.health();
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : "worker registry unavailable",
      };
    }
  }

  async drainWorker(workerId: string) {
    await this.ensureInitialized();
    const worker = await this.store.getWorker(workerId);
    if (!worker) throw new ProviderError("worker_not_found", "GPUワーカーが見つかりません", 404);
    await this.reconcileWorker(worker);
    const claimed = await this.store.claimIdleWorkerForDrain(workerId, new Date(this.now()));
    if (!claimed) {
      const current = await this.store.getWorker(workerId);
      const liveAssignments = current ? await this.store.countAssignmentsForWorker(workerId, [
        "requested", "provisioning", "ready", "active",
      ]) : 0;
      if ((current?.activeSessions ?? 0) > 0 || liveAssignments > 0) {
        throw new ProviderError("worker_has_active_sessions", "処理中のセッションがあるためGPUワーカーを停止できません", 409);
      }
      throw new ProviderError("worker_not_idle", "GPUワーカーを停止可能な状態にできません", 409);
    }
    try {
      await this.admin.drain(claimed);
    } catch (error) {
      await this.store.updateWorker(claimed.id, {
        enabled: false,
        status: "unhealthy",
        health: { message: "GPUワーカーのdrainに失敗しました" },
      }, new Date(this.now()));
      throw error;
    }
    return claimed;
  }

  async stopWorker(workerId: string) {
    const worker = await this.drainWorker(workerId);
    if (!worker.podId) {
      throw new ProviderError("worker_pod_missing", "GPUワーカーのRunPod Pod IDがありません", 409);
    }
    try {
      await this.fleet.stopPod(worker.podId);
      return await this.store.updateWorker(worker.id, { status: "stopped", enabled: true }, new Date(this.now()));
    } catch (error) {
      await this.store.updateWorker(worker.id, {
        enabled: false,
        status: "unhealthy",
        health: { message: "GPUワーカーの停止に失敗しました" },
      }, new Date(this.now()));
      throw error;
    }
  }

  async response(assignment: AssignmentRecord): Promise<AssignmentResponse> {
    const worker = assignment.workerId ? await this.store.getWorker(assignment.workerId) : null;
    const response: AssignmentResponse = {
      id: assignment.id,
      session_id: assignment.sessionId,
      model_id: assignment.modelId,
      purpose: assignment.purpose,
      status: assignment.status,
      ...(worker ? { worker: workerSummary(worker) } : {}),
      message: assignment.message,
      retry_after_ms: assignment.status === "requested" || assignment.status === "provisioning"
        ? Math.min(this.config.workerReconcileIntervalMs, 5000)
        : null,
    };
    if (
      worker
      && worker.enabled
      && worker.status === "ready"
      && worker.modelId === assignment.modelId
      && (assignment.status === "ready" || assignment.status === "active")
    ) {
      const issued = createWorkerTicket({
        secret: this.config.workerTicketSecret,
        workerId: worker.id,
        sessionId: assignment.sessionId,
        modelId: assignment.modelId,
        purpose: assignment.purpose,
        nowMs: this.now(),
        ttlSeconds: this.config.workerTicketTtlSeconds,
      });
      response.connection = {
        websocket_url: `${worker.serviceUrl.replace(/^http/, "ws")}/v1/realtime`,
        ticket: issued.token,
        expires_at: new Date(issued.claims.exp * 1000).toISOString(),
        catalog_revision: typeof worker.health?.catalog_revision === "string"
          ? worker.health.catalog_revision
          : null,
      };
    }
    return response;
  }

  async close() { await this.store.close(); }
}

export function createWorkerScheduler(
  config: AppConfig,
  provider: PodProvider,
  options: {
    store?: WorkerPoolStore;
    fleet?: RunPodFleetClient;
    admin?: WorkerAdminClient;
    now?: () => number;
  } = {},
) {
  return new WorkerScheduler(
    config,
    options.store ?? createWorkerPoolStore(config),
    options.fleet ?? createFleetClient(config, provider),
    options.admin ?? createWorkerAdminClient(config, provider),
    options.now,
  );
}
