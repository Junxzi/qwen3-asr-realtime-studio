export type DesiredStatus = "RUNNING" | "EXITED" | "TERMINATED";
export type ControlStage = "stopped" | "starting" | "ready" | "stopping" | "error";

export interface PodInfo {
  id: string;
  name?: string;
  desiredStatus: DesiredStatus;
  costPerHr?: string | number;
  gpu?: { id?: string; displayName?: string; count?: number } | null;
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

