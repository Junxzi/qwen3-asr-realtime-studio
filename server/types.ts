export type DesiredStatus = "RUNNING" | "EXITED" | "TERMINATED";
export type ControlStage = "stopped" | "starting" | "ready" | "stopping" | "error";

export interface PodInfo {
  id: string;
  name?: string;
  desiredStatus: DesiredStatus;
  costPerHr?: string | number;
  gpu?: { id?: string; displayName?: string; count?: number } | null;
  env?: Record<string, string> | null;
}

export interface ServiceProbe {
  ready: boolean;
  status?: number;
  health?: Record<string, unknown>;
  message?: string;
}

export interface PodProvider {
  getPod(): Promise<PodInfo>;
  startPod(): Promise<void>;
  stopPod(): Promise<void>;
  probeService(): Promise<ServiceProbe>;
}

export interface OperationState {
  id: string;
  kind: "start" | "stop";
  requestedAt: string;
}

export type WorkerRuntime = "realtime" | "batch";
export type WorkerOrigin = "static" | "dynamic";
export type WorkerStatus = "stopped" | "starting" | "loading" | "ready" | "draining" | "unhealthy" | "terminated";
export type AssignmentStatus = "requested" | "provisioning" | "ready" | "active" | "released" | "failed";

export interface KnownWorkerConfig {
  id: string;
  podId: string;
  name: string;
  serviceUrl: string;
  modelId: string;
  runtime: WorkerRuntime;
  maxSessions: number;
  enabled: boolean;
}

export interface WorkerRecord extends KnownWorkerConfig {
  origin: WorkerOrigin;
  status: WorkerStatus;
  activeSessions: number;
  gpu: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentRecord {
  id: string;
  sessionId: string;
  workerId: string | null;
  modelId: string;
  purpose: WorkerRuntime;
  status: AssignmentStatus;
  message: string | null;
  leaseExpiresAt: Date;
  activatedAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
