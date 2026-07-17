import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { inferenceWorkers, transcriptionAssignments } from "./schema.js";
import { StoreError } from "./transcriptions.js";
import type {
  AssignmentRecord,
  AssignmentStatus,
  KnownWorkerConfig,
  WorkerRecord,
  WorkerRuntime,
  WorkerStatus,
} from "./types.js";

export interface WorkerUpdate {
  podId?: string;
  name?: string;
  serviceUrl?: string;
  modelId?: string;
  runtime?: WorkerRuntime;
  status?: WorkerStatus;
  maxSessions?: number;
  activeSessions?: number;
  enabled?: boolean;
  gpu?: Record<string, unknown> | null;
  health?: Record<string, unknown> | null;
  lastHeartbeatAt?: Date | null;
}

export interface ProvisioningWorkerClaim {
  worker: WorkerRecord;
  acquired: boolean;
}

export interface WorkerPoolStore {
  readonly kind: "memory" | "postgres";
  health(): Promise<{ ready: boolean; message?: string }>;
  seedKnownWorkers(workers: KnownWorkerConfig[], now: Date): Promise<void>;
  listWorkers(): Promise<WorkerRecord[]>;
  getWorker(id: string): Promise<WorkerRecord | null>;
  countAssignments(statuses: AssignmentStatus[]): Promise<number>;
  countAssignmentsForWorker(workerId: string, statuses: AssignmentStatus[]): Promise<number>;
  upsertWorker(worker: KnownWorkerConfig, status: WorkerStatus, now: Date): Promise<WorkerRecord>;
  claimProvisioningWorker(
    worker: KnownWorkerConfig,
    poolMaxWorkers: number,
    now: Date,
  ): Promise<ProvisioningWorkerClaim | null>;
  claimStoppedWorkerForStart(workerId: string, now: Date): Promise<WorkerRecord | null>;
  finalizeProvisioningWorker(
    workerId: string,
    pod: { podId: string; name: string; serviceUrl: string },
    now: Date,
  ): Promise<WorkerRecord | null>;
  claimIdleWorkerForDrain(workerId: string, now: Date): Promise<WorkerRecord | null>;
  reapStaleProvisioningWorkers(now: Date, timeoutSeconds: number): Promise<number>;
  updateWorker(id: string, update: WorkerUpdate, now: Date): Promise<WorkerRecord | null>;
  updateWorkerIfStatus(
    id: string,
    expectedStatus: WorkerStatus,
    update: WorkerUpdate,
    now: Date,
  ): Promise<WorkerRecord | null>;
  createRequestedAssignment(input: {
    sessionId: string;
    modelId: string;
    purpose: WorkerRuntime;
    now: Date;
    leaseSeconds: number;
  }): Promise<AssignmentRecord>;
  getAssignmentBySession(sessionId: string): Promise<AssignmentRecord | null>;
  reserveReadyWorker(assignmentId: string, now: Date, leaseSeconds: number): Promise<AssignmentRecord>;
  markProvisioning(assignmentId: string, workerId: string | null, message: string, now: Date, leaseSeconds: number): Promise<AssignmentRecord>;
  markFailed(assignmentId: string, message: string, now: Date): Promise<AssignmentRecord>;
  touch(sessionId: string, now: Date, leaseSeconds: number): Promise<AssignmentRecord | null>;
  release(sessionId: string, now: Date): Promise<AssignmentRecord | null>;
  reapExpired(now: Date): Promise<number>;
  close(): Promise<void>;
}

function cloneWorker(worker: WorkerRecord): WorkerRecord {
  return {
    ...worker,
    gpu: worker.gpu ? { ...worker.gpu } : null,
    health: worker.health ? { ...worker.health } : null,
    lastHeartbeatAt: worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt) : null,
    createdAt: new Date(worker.createdAt),
    updatedAt: new Date(worker.updatedAt),
  };
}

function cloneAssignment(assignment: AssignmentRecord): AssignmentRecord {
  return {
    ...assignment,
    leaseExpiresAt: new Date(assignment.leaseExpiresAt),
    activatedAt: assignment.activatedAt ? new Date(assignment.activatedAt) : null,
    releasedAt: assignment.releasedAt ? new Date(assignment.releasedAt) : null,
    createdAt: new Date(assignment.createdAt),
    updatedAt: new Date(assignment.updatedAt),
  };
}

function leaseUntil(now: Date, leaseSeconds: number) {
  return new Date(now.getTime() + leaseSeconds * 1000);
}

export class MemoryWorkerPoolStore implements WorkerPoolStore {
  readonly kind = "memory" as const;
  private workers = new Map<string, WorkerRecord>();
  private assignments = new Map<string, AssignmentRecord>();
  private assignmentIdBySession = new Map<string, string>();

  private assertPodIdAvailable(podId: string, workerId: string) {
    if (!podId) return;
    const owner = [...this.workers.values()].find((worker) => worker.id !== workerId && worker.podId === podId);
    if (owner) throw new StoreError("duplicate_worker_pod_id", `RunPod Pod ${podId} is already registered`, 409);
  }

  async health() { return { ready: true }; }

  async seedKnownWorkers(workers: KnownWorkerConfig[], now: Date) {
    const seededIds = new Set(workers.map((worker) => worker.id));
    const podOwners = new Map<string, string>();
    for (const existing of this.workers.values()) {
      if (existing.podId && !seededIds.has(existing.id)) podOwners.set(existing.podId, existing.id);
    }
    for (const worker of workers) {
      if (!worker.podId) continue;
      const owner = podOwners.get(worker.podId);
      if (owner && owner !== worker.id) {
        throw new StoreError("duplicate_worker_pod_id", `RunPod Pod ${worker.podId} is already registered`, 409);
      }
      podOwners.set(worker.podId, worker.id);
    }
    const knownIds = new Set(workers.map((worker) => worker.id));
    for (const existing of this.workers.values()) {
      if (existing.origin === "static" && !knownIds.has(existing.id)) {
        existing.enabled = false;
        existing.updatedAt = now;
      }
    }
    for (const worker of workers) {
      const existing = this.workers.get(worker.id);
      if (existing) {
        Object.assign(existing, {
          podId: worker.podId,
          name: worker.name,
          serviceUrl: worker.serviceUrl,
          modelId: worker.modelId,
          runtime: worker.runtime,
          maxSessions: worker.maxSessions,
          enabled: worker.enabled,
          origin: "static",
          updatedAt: now,
        });
      } else {
        this.workers.set(worker.id, {
          ...worker,
          origin: "static",
          status: "stopped",
          activeSessions: 0,
          gpu: null,
          health: null,
          lastHeartbeatAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  async listWorkers() {
    return [...this.workers.values()].map(cloneWorker).sort((left, right) => left.id.localeCompare(right.id));
  }

  async getWorker(id: string) {
    const worker = this.workers.get(id);
    return worker ? cloneWorker(worker) : null;
  }

  async countAssignments(statuses: AssignmentStatus[]) {
    return [...this.assignments.values()].filter((assignment) => statuses.includes(assignment.status)).length;
  }

  async countAssignmentsForWorker(workerId: string, statuses: AssignmentStatus[]) {
    return [...this.assignments.values()].filter((assignment) => (
      assignment.workerId === workerId && statuses.includes(assignment.status)
    )).length;
  }

  async upsertWorker(worker: KnownWorkerConfig, status: WorkerStatus, now: Date) {
    this.assertPodIdAvailable(worker.podId, worker.id);
    const existing = this.workers.get(worker.id);
    if (existing) {
      Object.assign(existing, worker, { status, updatedAt: now });
      return cloneWorker(existing);
    }
    const created: WorkerRecord = {
      ...worker,
      origin: "dynamic",
      status,
      activeSessions: 0,
      gpu: null,
      health: null,
      lastHeartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.workers.set(worker.id, created);
    return cloneWorker(created);
  }

  async claimProvisioningWorker(worker: KnownWorkerConfig, poolMaxWorkers: number, now: Date) {
    const coldWorker = [...this.workers.values()].find((candidate) => (
      candidate.enabled
      && candidate.modelId === worker.modelId
      && candidate.runtime === worker.runtime
      && ["starting", "loading"].includes(candidate.status)
    ));
    if (coldWorker) return { worker: cloneWorker(coldWorker), acquired: false };
    const existing = this.workers.get(worker.id);
    if (existing?.enabled) return null;
    if ([...this.workers.values()].filter((candidate) => candidate.enabled).length >= poolMaxWorkers) return null;
    if (existing) {
      if (existing.origin !== "dynamic" || existing.status !== "terminated" || existing.podId) return null;
      Object.assign(existing, worker, {
        origin: "dynamic",
        status: "starting",
        activeSessions: 0,
        enabled: true,
        gpu: null,
        health: null,
        lastHeartbeatAt: null,
        updatedAt: now,
      });
      return { worker: cloneWorker(existing), acquired: true };
    }
    const created: WorkerRecord = {
      ...worker,
      origin: "dynamic",
      status: "starting",
      activeSessions: 0,
      enabled: true,
      gpu: null,
      health: null,
      lastHeartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.workers.set(worker.id, created);
    return { worker: cloneWorker(created), acquired: true };
  }

  async claimStoppedWorkerForStart(workerId: string, now: Date) {
    const worker = this.workers.get(workerId);
    if (!worker?.enabled || !worker.podId || worker.status !== "stopped") return null;
    worker.status = "starting";
    worker.health = null;
    worker.updatedAt = now;
    return cloneWorker(worker);
  }

  async claimIdleWorkerForDrain(workerId: string, now: Date) {
    const worker = this.workers.get(workerId);
    if (!worker?.enabled || worker.activeSessions !== 0 || ["stopped", "terminated"].includes(worker.status)) return null;
    const hasLiveAssignment = [...this.assignments.values()].some((assignment) => (
      assignment.workerId === workerId
      && ["requested", "provisioning", "ready", "active"].includes(assignment.status)
    ));
    if (hasLiveAssignment) return null;
    worker.enabled = false;
    worker.status = "draining";
    worker.updatedAt = now;
    return cloneWorker(worker);
  }

  async finalizeProvisioningWorker(
    workerId: string,
    pod: { podId: string; name: string; serviceUrl: string },
    now: Date,
  ) {
    const worker = this.workers.get(workerId);
    if (
      !worker?.enabled
      || worker.origin !== "dynamic"
      || worker.status !== "starting"
      || worker.podId
    ) return null;
    this.assertPodIdAvailable(pod.podId, workerId);
    Object.assign(worker, pod, { status: "starting", health: null, updatedAt: now });
    return cloneWorker(worker);
  }

  async reapStaleProvisioningWorkers(now: Date, timeoutSeconds: number) {
    const cutoff = now.getTime() - timeoutSeconds * 1000;
    let count = 0;
    for (const worker of this.workers.values()) {
      if (
        worker.origin === "dynamic"
        && worker.enabled
        && !worker.podId
        && worker.status === "starting"
        && worker.updatedAt.getTime() < cutoff
      ) {
        worker.enabled = false;
        worker.status = "terminated";
        worker.health = { message: "GPU worker provisioning timed out" };
        worker.updatedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async updateWorker(id: string, update: WorkerUpdate, now: Date) {
    const worker = this.workers.get(id);
    if (!worker) return null;
    if (update.podId !== undefined) this.assertPodIdAvailable(update.podId, id);
    Object.assign(worker, update, { updatedAt: now });
    return cloneWorker(worker);
  }

  async updateWorkerIfStatus(id: string, expectedStatus: WorkerStatus, update: WorkerUpdate, now: Date) {
    const worker = this.workers.get(id);
    if (!worker || worker.status !== expectedStatus) return null;
    if (update.podId !== undefined) this.assertPodIdAvailable(update.podId, id);
    Object.assign(worker, update, { updatedAt: now });
    return cloneWorker(worker);
  }

  async createRequestedAssignment(input: { sessionId: string; modelId: string; purpose: WorkerRuntime; now: Date; leaseSeconds: number }) {
    const existingId = this.assignmentIdBySession.get(input.sessionId);
    if (existingId) return cloneAssignment(this.assignments.get(existingId)!);
    const assignment: AssignmentRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      workerId: null,
      modelId: input.modelId,
      purpose: input.purpose,
      status: "requested",
      message: "利用可能なGPUワーカーを探しています",
      leaseExpiresAt: leaseUntil(input.now, input.leaseSeconds),
      activatedAt: null,
      releasedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.assignments.set(assignment.id, assignment);
    this.assignmentIdBySession.set(assignment.sessionId, assignment.id);
    return cloneAssignment(assignment);
  }

  async getAssignmentBySession(sessionId: string) {
    const id = this.assignmentIdBySession.get(sessionId);
    const assignment = id ? this.assignments.get(id) : undefined;
    return assignment ? cloneAssignment(assignment) : null;
  }

  async reserveReadyWorker(assignmentId: string, now: Date, leaseSeconds: number) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
    if (["ready", "active", "released", "failed"].includes(assignment.status)) return cloneAssignment(assignment);
    const worker = [...this.workers.values()]
      .filter((candidate) => candidate.enabled
        && candidate.status === "ready"
        && candidate.modelId === assignment.modelId
        && candidate.runtime === assignment.purpose
        && candidate.activeSessions < candidate.maxSessions)
      .sort((left, right) => left.activeSessions - right.activeSessions || left.id.localeCompare(right.id))[0];
    if (!worker) return cloneAssignment(assignment);
    worker.activeSessions += 1;
    worker.updatedAt = now;
    assignment.workerId = worker.id;
    assignment.status = "ready";
    assignment.message = null;
    assignment.leaseExpiresAt = leaseUntil(now, leaseSeconds);
    assignment.updatedAt = now;
    return cloneAssignment(assignment);
  }

  async markProvisioning(assignmentId: string, workerId: string | null, message: string, now: Date, leaseSeconds: number) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
    if (!["requested", "provisioning"].includes(assignment.status)) return cloneAssignment(assignment);
    assignment.workerId = workerId;
    assignment.status = "provisioning";
    assignment.message = message;
    assignment.leaseExpiresAt = leaseUntil(now, leaseSeconds);
    assignment.updatedAt = now;
    return cloneAssignment(assignment);
  }

  async markFailed(assignmentId: string, message: string, now: Date) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
    assignment.status = "failed";
    assignment.message = message;
    assignment.updatedAt = now;
    return cloneAssignment(assignment);
  }

  async touch(sessionId: string, now: Date, leaseSeconds: number) {
    const assignmentId = this.assignmentIdBySession.get(sessionId);
    const stored = assignmentId ? this.assignments.get(assignmentId) : undefined;
    if (!stored || (stored.status !== "ready" && stored.status !== "active")) {
      return stored ? cloneAssignment(stored) : null;
    }
    stored.status = "active";
    stored.activatedAt ??= now;
    stored.leaseExpiresAt = leaseUntil(now, leaseSeconds);
    stored.updatedAt = now;
    return cloneAssignment(stored);
  }

  async release(sessionId: string, now: Date) {
    const assignmentId = this.assignmentIdBySession.get(sessionId);
    const stored = assignmentId ? this.assignments.get(assignmentId) : undefined;
    if (!stored) return null;
    if (stored.status === "released") return cloneAssignment(stored);
    if ((stored.status === "ready" || stored.status === "active") && stored.workerId) {
      const worker = this.workers.get(stored.workerId);
      if (worker) {
        worker.activeSessions = Math.max(0, worker.activeSessions - 1);
        worker.updatedAt = now;
      }
    }
    stored.status = "released";
    stored.releasedAt = now;
    stored.updatedAt = now;
    return cloneAssignment(stored);
  }

  async reapExpired(now: Date) {
    let count = 0;
    for (const assignment of this.assignments.values()) {
      if (
        !["requested", "provisioning", "ready", "active"].includes(assignment.status)
        || assignment.leaseExpiresAt >= now
      ) continue;
      if ((assignment.status === "ready" || assignment.status === "active") && assignment.workerId) {
        const worker = this.workers.get(assignment.workerId);
        if (worker) {
          worker.activeSessions = Math.max(0, worker.activeSessions - 1);
          worker.updatedAt = now;
        }
      }
      assignment.status = "released";
      assignment.releasedAt = now;
      assignment.updatedAt = now;
      count += 1;
    }
    return count;
  }

  async close() {}
}

type WorkerRow = typeof inferenceWorkers.$inferSelect;
type AssignmentRow = typeof transcriptionAssignments.$inferSelect;

function mapWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    podId: row.podId,
    name: row.name,
    serviceUrl: row.serviceUrl,
    modelId: row.modelId,
    runtime: row.runtime as WorkerRuntime,
    origin: row.origin as WorkerRecord["origin"],
    status: row.status as WorkerStatus,
    maxSessions: row.maxSessions,
    activeSessions: row.activeSessions,
    enabled: row.enabled,
    gpu: row.gpu,
    health: row.health,
    lastHeartbeatAt: row.lastHeartbeatAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAssignment(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workerId: row.workerId,
    modelId: row.modelId,
    purpose: row.purpose as WorkerRuntime,
    status: row.status as AssignmentStatus,
    message: row.message,
    leaseExpiresAt: row.leaseExpiresAt,
    activatedAt: row.activatedAt,
    releasedAt: row.releasedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresWorkerPoolStore implements WorkerPoolStore {
  readonly kind = "postgres" as const;
  private pool: Pool;
  private database;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
    });
    this.database = drizzle(this.pool);
  }

  private fail(error: unknown): never {
    if (error instanceof StoreError) throw error;
    console.error(JSON.stringify({
      level: "error",
      event: "worker_pool_database_error",
      message: error instanceof Error ? error.message : "database unavailable",
    }));
    throw new StoreError("database_unavailable", "ワーカープールDBへ接続できません", 503);
  }

  async health() {
    try {
      await this.database.select({ value: sql<number>`count(*)::int` }).from(inferenceWorkers);
      return { ready: true };
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "worker_pool_health_error",
        message: error instanceof Error ? error.message : "database unavailable",
      }));
      return { ready: false, message: "database unavailable" };
    }
  }

  async seedKnownWorkers(workers: KnownWorkerConfig[], now: Date) {
    try {
      const removedStaticWorkers = workers.length > 0
        ? and(
            eq(inferenceWorkers.origin, "static"),
            notInArray(inferenceWorkers.id, workers.map((worker) => worker.id)),
          )
        : eq(inferenceWorkers.origin, "static");
      await this.database.update(inferenceWorkers).set({ enabled: false, updatedAt: now })
        .where(removedStaticWorkers);
      for (const worker of workers) {
        await this.database.insert(inferenceWorkers).values({
          id: worker.id,
          podId: worker.podId,
          name: worker.name,
          serviceUrl: worker.serviceUrl,
          modelId: worker.modelId,
          runtime: worker.runtime,
          origin: "static",
          status: "stopped",
          maxSessions: worker.maxSessions,
          activeSessions: 0,
          enabled: worker.enabled,
          gpu: null,
          health: null,
          lastHeartbeatAt: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: inferenceWorkers.id,
          set: {
            podId: worker.podId,
            name: worker.name,
            serviceUrl: worker.serviceUrl,
            modelId: worker.modelId,
            runtime: worker.runtime,
            origin: "static",
            maxSessions: worker.maxSessions,
            enabled: worker.enabled,
            updatedAt: now,
          },
        });
      }
    } catch (error) { this.fail(error); }
  }

  async listWorkers() {
    try {
      return (await this.database.select().from(inferenceWorkers).orderBy(inferenceWorkers.id)).map(mapWorker);
    } catch (error) { this.fail(error); }
  }

  async getWorker(id: string) {
    try {
      const [row] = await this.database.select().from(inferenceWorkers).where(eq(inferenceWorkers.id, id)).limit(1);
      return row ? mapWorker(row) : null;
    } catch (error) { this.fail(error); }
  }

  async countAssignments(statuses: AssignmentStatus[]) {
    try {
      const [row] = await this.database.select({ value: sql<number>`count(*)::int` })
        .from(transcriptionAssignments)
        .where(inArray(transcriptionAssignments.status, statuses));
      return Number(row?.value || 0);
    } catch (error) { this.fail(error); }
  }

  async countAssignmentsForWorker(workerId: string, statuses: AssignmentStatus[]) {
    try {
      const [row] = await this.database.select({ value: sql<number>`count(*)::int` })
        .from(transcriptionAssignments)
        .where(and(
          eq(transcriptionAssignments.workerId, workerId),
          inArray(transcriptionAssignments.status, statuses),
        ));
      return Number(row?.value || 0);
    } catch (error) { this.fail(error); }
  }

  async upsertWorker(worker: KnownWorkerConfig, status: WorkerStatus, now: Date) {
    try {
      const [row] = await this.database.insert(inferenceWorkers).values({
        id: worker.id,
        podId: worker.podId,
        name: worker.name,
        serviceUrl: worker.serviceUrl,
        modelId: worker.modelId,
        runtime: worker.runtime,
        origin: "dynamic",
        status,
        maxSessions: worker.maxSessions,
        activeSessions: 0,
        enabled: worker.enabled,
        gpu: null,
        health: null,
        lastHeartbeatAt: null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: inferenceWorkers.id,
        set: { ...worker, status, updatedAt: now },
      }).returning();
      return mapWorker(row);
    } catch (error) { this.fail(error); }
  }

  async claimProvisioningWorker(worker: KnownWorkerConfig, poolMaxWorkers: number, now: Date) {
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('qwen_worker_pool_provision'))`);
        const [coldWorker] = await transaction.select().from(inferenceWorkers)
          .where(and(
            eq(inferenceWorkers.enabled, true),
            eq(inferenceWorkers.modelId, worker.modelId),
            eq(inferenceWorkers.runtime, worker.runtime),
            inArray(inferenceWorkers.status, ["starting", "loading"]),
          ))
          .orderBy(asc(inferenceWorkers.createdAt), asc(inferenceWorkers.id))
          .limit(1)
          .for("update");
        if (coldWorker) return { worker: mapWorker(coldWorker), acquired: false };
        const [existing] = await transaction.select().from(inferenceWorkers)
          .where(eq(inferenceWorkers.id, worker.id)).limit(1).for("update");
        if (existing?.enabled) return null;
        const [countRow] = await transaction.select({ value: sql<number>`count(*)::int` })
          .from(inferenceWorkers)
          .where(eq(inferenceWorkers.enabled, true));
        if (Number(countRow?.value || 0) >= poolMaxWorkers) return null;
        if (existing) {
          if (existing.origin !== "dynamic" || existing.status !== "terminated" || existing.podId) return null;
          const [reactivated] = await transaction.update(inferenceWorkers).set({
            podId: worker.podId,
            name: worker.name,
            serviceUrl: worker.serviceUrl,
            modelId: worker.modelId,
            runtime: worker.runtime,
            origin: "dynamic",
            status: "starting",
            maxSessions: worker.maxSessions,
            activeSessions: 0,
            enabled: true,
            gpu: null,
            health: null,
            lastHeartbeatAt: null,
            updatedAt: now,
          }).where(eq(inferenceWorkers.id, worker.id)).returning();
          return { worker: mapWorker(reactivated), acquired: true };
        }
        const [created] = await transaction.insert(inferenceWorkers).values({
          id: worker.id,
          podId: worker.podId,
          name: worker.name,
          serviceUrl: worker.serviceUrl,
          modelId: worker.modelId,
          runtime: worker.runtime,
          origin: "dynamic",
          status: "starting",
          maxSessions: worker.maxSessions,
          activeSessions: 0,
          enabled: worker.enabled,
          gpu: null,
          health: null,
          lastHeartbeatAt: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing({ target: inferenceWorkers.id }).returning();
        return created ? { worker: mapWorker(created), acquired: true } : null;
      });
    } catch (error) { this.fail(error); }
  }

  async claimStoppedWorkerForStart(workerId: string, now: Date) {
    try {
      const [worker] = await this.database.update(inferenceWorkers).set({
        status: "starting",
        health: null,
        updatedAt: now,
      }).where(and(
        eq(inferenceWorkers.id, workerId),
        eq(inferenceWorkers.enabled, true),
        eq(inferenceWorkers.status, "stopped"),
        sql`${inferenceWorkers.podId} <> ''`,
      )).returning();
      return worker ? mapWorker(worker) : null;
    } catch (error) { this.fail(error); }
  }

  async claimIdleWorkerForDrain(workerId: string, now: Date) {
    try {
      return await this.database.transaction(async (transaction) => {
        const [worker] = await transaction.select().from(inferenceWorkers)
          .where(eq(inferenceWorkers.id, workerId)).limit(1).for("update");
        if (!worker?.enabled || worker.activeSessions !== 0 || ["stopped", "terminated"].includes(worker.status)) return null;
        const [countRow] = await transaction.select({ value: sql<number>`count(*)::int` })
          .from(transcriptionAssignments)
          .where(and(
            eq(transcriptionAssignments.workerId, workerId),
            inArray(transcriptionAssignments.status, ["requested", "provisioning", "ready", "active"]),
          ));
        if (Number(countRow?.value || 0) !== 0) return null;
        const [claimed] = await transaction.update(inferenceWorkers).set({
          enabled: false,
          status: "draining",
          updatedAt: now,
        }).where(eq(inferenceWorkers.id, workerId)).returning();
        return claimed ? mapWorker(claimed) : null;
      });
    } catch (error) { this.fail(error); }
  }

  async finalizeProvisioningWorker(
    workerId: string,
    pod: { podId: string; name: string; serviceUrl: string },
    now: Date,
  ) {
    try {
      const [row] = await this.database.update(inferenceWorkers).set({
        ...pod,
        status: "starting",
        health: null,
        updatedAt: now,
      }).where(and(
        eq(inferenceWorkers.id, workerId),
        eq(inferenceWorkers.origin, "dynamic"),
        eq(inferenceWorkers.enabled, true),
        eq(inferenceWorkers.status, "starting"),
        eq(inferenceWorkers.podId, ""),
      )).returning();
      return row ? mapWorker(row) : null;
    } catch (error) { this.fail(error); }
  }

  async reapStaleProvisioningWorkers(now: Date, timeoutSeconds: number) {
    try {
      const cutoff = new Date(now.getTime() - timeoutSeconds * 1000);
      const rows = await this.database.update(inferenceWorkers).set({
        enabled: false,
        status: "terminated",
        health: { message: "GPU worker provisioning timed out" },
        updatedAt: now,
      }).where(and(
        eq(inferenceWorkers.origin, "dynamic"),
        eq(inferenceWorkers.enabled, true),
        eq(inferenceWorkers.podId, ""),
        eq(inferenceWorkers.status, "starting"),
        lt(inferenceWorkers.updatedAt, cutoff),
      )).returning({ id: inferenceWorkers.id });
      return rows.length;
    } catch (error) { this.fail(error); }
  }

  async updateWorker(id: string, update: WorkerUpdate, now: Date) {
    try {
      const [row] = await this.database.update(inferenceWorkers).set({ ...update, updatedAt: now }).where(eq(inferenceWorkers.id, id)).returning();
      return row ? mapWorker(row) : null;
    } catch (error) { this.fail(error); }
  }

  async updateWorkerIfStatus(id: string, expectedStatus: WorkerStatus, update: WorkerUpdate, now: Date) {
    try {
      const [row] = await this.database.update(inferenceWorkers).set({ ...update, updatedAt: now }).where(and(
        eq(inferenceWorkers.id, id),
        eq(inferenceWorkers.status, expectedStatus),
      )).returning();
      return row ? mapWorker(row) : null;
    } catch (error) { this.fail(error); }
  }

  async createRequestedAssignment(input: { sessionId: string; modelId: string; purpose: WorkerRuntime; now: Date; leaseSeconds: number }) {
    try {
      await this.database.insert(transcriptionAssignments).values({
        id: randomUUID(),
        sessionId: input.sessionId,
        workerId: null,
        modelId: input.modelId,
        purpose: input.purpose,
        status: "requested",
        message: "利用可能なGPUワーカーを探しています",
        leaseExpiresAt: leaseUntil(input.now, input.leaseSeconds),
        activatedAt: null,
        releasedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }).onConflictDoNothing({ target: transcriptionAssignments.sessionId });
      const [row] = await this.database.select().from(transcriptionAssignments)
        .where(eq(transcriptionAssignments.sessionId, input.sessionId)).limit(1);
      if (!row) throw new StoreError("assignment_not_found", "ワーカー割当を作成できませんでした", 503);
      return mapAssignment(row);
    } catch (error) { this.fail(error); }
  }

  async getAssignmentBySession(sessionId: string) {
    try {
      const [row] = await this.database.select().from(transcriptionAssignments)
        .where(eq(transcriptionAssignments.sessionId, sessionId)).limit(1);
      return row ? mapAssignment(row) : null;
    } catch (error) { this.fail(error); }
  }

  async reserveReadyWorker(assignmentId: string, now: Date, leaseSeconds: number) {
    try {
      return await this.database.transaction(async (transaction) => {
        const [assignment] = await transaction.select().from(transcriptionAssignments)
          .where(eq(transcriptionAssignments.id, assignmentId)).limit(1).for("update");
        if (!assignment) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
        if (["ready", "active", "released", "failed"].includes(assignment.status)) return mapAssignment(assignment);
        const [worker] = await transaction.select().from(inferenceWorkers)
          .where(and(
            eq(inferenceWorkers.enabled, true),
            eq(inferenceWorkers.status, "ready"),
            eq(inferenceWorkers.modelId, assignment.modelId),
            eq(inferenceWorkers.runtime, assignment.purpose),
            sql`${inferenceWorkers.activeSessions} < ${inferenceWorkers.maxSessions}`,
          ))
          .orderBy(asc(inferenceWorkers.activeSessions), asc(inferenceWorkers.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!worker) return mapAssignment(assignment);
        await transaction.update(inferenceWorkers)
          .set({ activeSessions: sql`${inferenceWorkers.activeSessions} + 1`, updatedAt: now })
          .where(eq(inferenceWorkers.id, worker.id));
        const [saved] = await transaction.update(transcriptionAssignments).set({
          workerId: worker.id,
          status: "ready",
          message: null,
          leaseExpiresAt: leaseUntil(now, leaseSeconds),
          updatedAt: now,
        }).where(eq(transcriptionAssignments.id, assignment.id)).returning();
        return mapAssignment(saved);
      });
    } catch (error) { this.fail(error); }
  }

  async markProvisioning(assignmentId: string, workerId: string | null, message: string, now: Date, leaseSeconds: number) {
    try {
      const [row] = await this.database.update(transcriptionAssignments).set({
        workerId,
        status: "provisioning",
        message,
        leaseExpiresAt: leaseUntil(now, leaseSeconds),
        updatedAt: now,
      }).where(and(
        eq(transcriptionAssignments.id, assignmentId),
        inArray(transcriptionAssignments.status, ["requested", "provisioning"]),
      )).returning();
      if (row) return mapAssignment(row);
      const [existing] = await this.database.select().from(transcriptionAssignments).where(eq(transcriptionAssignments.id, assignmentId)).limit(1);
      if (!existing) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
      return mapAssignment(existing);
    } catch (error) { this.fail(error); }
  }

  async markFailed(assignmentId: string, message: string, now: Date) {
    try {
      const [row] = await this.database.update(transcriptionAssignments).set({ status: "failed", message, updatedAt: now })
        .where(eq(transcriptionAssignments.id, assignmentId)).returning();
      if (!row) throw new StoreError("assignment_not_found", "ワーカー割当が見つかりません", 404);
      return mapAssignment(row);
    } catch (error) { this.fail(error); }
  }

  async touch(sessionId: string, now: Date, leaseSeconds: number) {
    try {
      const [row] = await this.database.update(transcriptionAssignments).set({
        status: "active",
        activatedAt: sql`coalesce(${transcriptionAssignments.activatedAt}, ${now})`,
        leaseExpiresAt: leaseUntil(now, leaseSeconds),
        updatedAt: now,
      }).where(and(
        eq(transcriptionAssignments.sessionId, sessionId),
        inArray(transcriptionAssignments.status, ["ready", "active"]),
      )).returning();
      return row ? mapAssignment(row) : await this.getAssignmentBySession(sessionId);
    } catch (error) { this.fail(error); }
  }

  async release(sessionId: string, now: Date) {
    try {
      return await this.database.transaction(async (transaction) => {
        const [assignment] = await transaction.select().from(transcriptionAssignments)
          .where(eq(transcriptionAssignments.sessionId, sessionId)).limit(1).for("update");
        if (!assignment) return null;
        if (assignment.status === "released") return mapAssignment(assignment);
        if ((assignment.status === "ready" || assignment.status === "active") && assignment.workerId) {
          await transaction.update(inferenceWorkers).set({
            activeSessions: sql`greatest(${inferenceWorkers.activeSessions} - 1, 0)`,
            updatedAt: now,
          }).where(eq(inferenceWorkers.id, assignment.workerId));
        }
        const [saved] = await transaction.update(transcriptionAssignments).set({
          status: "released",
          releasedAt: now,
          updatedAt: now,
        }).where(eq(transcriptionAssignments.id, assignment.id)).returning();
        return mapAssignment(saved);
      });
    } catch (error) { this.fail(error); }
  }

  async reapExpired(now: Date) {
    try {
      return await this.database.transaction(async (transaction) => {
        const assignments = await transaction.select().from(transcriptionAssignments)
          .where(and(
            lt(transcriptionAssignments.leaseExpiresAt, now),
            inArray(transcriptionAssignments.status, ["requested", "provisioning", "ready", "active"]),
          ))
          .for("update", { skipLocked: true });
        let releasedCount = 0;
        for (const assignment of assignments) {
          const [released] = await transaction.update(transcriptionAssignments).set({
            status: "released",
            releasedAt: now,
            updatedAt: now,
          }).where(and(
            eq(transcriptionAssignments.id, assignment.id),
            lt(transcriptionAssignments.leaseExpiresAt, now),
            inArray(transcriptionAssignments.status, ["requested", "provisioning", "ready", "active"]),
          )).returning({ id: transcriptionAssignments.id });
          if (!released) continue;
          if ((assignment.status === "ready" || assignment.status === "active") && assignment.workerId) {
            await transaction.update(inferenceWorkers).set({
              activeSessions: sql`greatest(${inferenceWorkers.activeSessions} - 1, 0)`,
              updatedAt: now,
            }).where(eq(inferenceWorkers.id, assignment.workerId));
          }
          releasedCount += 1;
        }
        return releasedCount;
      });
    } catch (error) { this.fail(error); }
  }

  async close() { await this.pool.end(); }
}

export function createWorkerPoolStore(config: AppConfig): WorkerPoolStore {
  if (config.transcriptStorage === "postgres") return new PostgresWorkerPoolStore(config.databaseUrl);
  return new MemoryWorkerPoolStore();
}
