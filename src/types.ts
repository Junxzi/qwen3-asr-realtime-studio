export type ControlStage = "stopped" | "starting" | "ready" | "stopping" | "error";

export interface HealthInfo {
  accelerator?: string;
  model?: string;
  backend?: string;
  catalog_revision?: string;
  catalog_terms?: number;
  chunk_seconds?: number;
  inference_mode?: string;
  gpu_utilization_percent?: number;
  gpu_memory_used_mb?: number;
  gpu_memory_total_mb?: number;
  gpu_temperature_c?: number;
  gpu_power_w?: number;
}

export interface ControlStatus {
  stage: ControlStage;
  control: {
    mode: "mock" | "readonly" | "live";
    available: boolean;
  };
  pod: {
    id: string;
    name?: string;
    desiredStatus: "RUNNING" | "EXITED" | "TERMINATED";
    costPerHr?: string | number;
    gpu?: { id?: string; displayName?: string; count?: number } | null;
  } | null;
  service: {
    url?: string;
    websocketUrl?: string;
    batchUrl?: string;
    ready: boolean;
    health?: HealthInfo;
    message?: string;
  };
  operation?: { id: string; kind: "start" | "stop"; requestedAt: string } | null;
  pool?: {
    total_workers: number;
    ready_workers: number;
    active_sessions: number;
    capacity: number;
    provisioning_assignments: number;
  };
  checkedAt: string;
}

export type AssignmentPurpose = "realtime" | "batch";
export type AssignmentStatus = "requested" | "provisioning" | "ready" | "active" | "released" | "failed";

export type ProcessingMode = "realtime" | "batch" | "hybrid";

export type PipelineNodeId =
  | "audio_ingest"
  | "vad"
  | "context_asr"
  | "streaming_sortformer"
  | "endpoint"
  | "lab_finalizer"
  | "replace_result"
  | "persist";

export type PipelineStatus = "waiting" | "queued" | "running" | "completed" | "fallback" | "failed";
export type PipelineWireStatus = Exclude<PipelineStatus, "waiting"> | "skipped";

export interface ProcessingAssignmentProfile {
  purpose: AssignmentPurpose;
  model_id: string;
}

export interface ProcessingPipelineNode {
  id: PipelineNodeId;
  label: string;
}

export interface ProcessingPipelineEdge {
  from: PipelineNodeId;
  to: PipelineNodeId;
}

export type ProcessingProfileAvailabilityStatus =
  | "configured"
  | "provisionable"
  | "setup_required"
  | "unknown";

export interface ProcessingProfileAvailability {
  selectable: boolean;
  configured: boolean | null;
  provisionable: boolean | null;
  validated: boolean;
  status: ProcessingProfileAvailabilityStatus;
}

export interface ProcessingProfile {
  id: ProcessingMode;
  display_name: string;
  description: string;
  input_modes: AsrInputMode[];
  primary_model_id: string;
  final_model_id: string | null;
  assignments: ProcessingAssignmentProfile[];
  nodes: ProcessingPipelineNode[];
  edges: ProcessingPipelineEdge[];
  /** Optional during the rolling deployment where an older control plane may still answer. */
  availability?: ProcessingProfileAvailability;
}

export interface PipelineStageEvent {
  type: "pipeline.stage";
  seq: number;
  pipeline_id: string;
  utterance_id: string;
  stage: PipelineNodeId;
  status: PipelineWireStatus;
  audio_end_ms: number | null;
  elapsed_ms: number | null;
  detail_code: string | null;
}

export interface PipelineLogEntry extends Omit<PipelineStageEvent, "status" | "seq"> {
  seq: number | null;
  status: PipelineStatus;
  received_at: string;
  source: "worker" | "client";
}

export interface RealtimeCapabilities {
  pipeline_events: boolean;
  input_end: boolean;
  partial_transcripts: boolean;
  speaker_hints: boolean;
  final_word_timestamps: boolean;
}

export interface AssignedWorker {
  id: string;
  pod_id: string;
  name?: string;
  status?: string;
  loaded_model_id?: string;
  gpu_type?: string | null;
  gpu?: { id?: string; displayName?: string; count?: number } | null;
  health?: HealthInfo | null;
}

export interface AssignmentConnection {
  websocket_url?: string;
  batch_url?: string;
  ticket: string;
  expires_at: string;
  catalog_revision?: string | null;
}

export interface InferenceAssignment {
  id: string;
  session_id: string;
  model_id: string;
  purpose: AssignmentPurpose;
  status: AssignmentStatus;
  worker?: AssignedWorker;
  connection?: AssignmentConnection;
  message?: string | null;
  retry_after_ms?: number | null;
}

export type AsrRuntime = "realtime" | "batch";
export type AsrInputMode = "microphone" | "file";

export interface AsrModel {
  id: string;
  display_name: string;
  short_name: string;
  description: string;
  runtime: AsrRuntime;
  input_modes: AsrInputMode[];
  supports_context: boolean;
  supports_diarization: boolean;
  recommended: boolean;
  estimated_vram_gb: number;
  source: "private_model" | "public_recipe";
  integration_status: "ready" | "gpu_validation_required" | "adapter_required";
  selectable: boolean;
}

export interface AsrModelCatalog {
  items: AsrModel[];
  default_model_id: string;
  processing_modes: ProcessingProfile[];
  default_processing_mode: ProcessingMode;
}

export interface PartialEvent {
  type: "transcript.partial";
  utterance_id: string;
  revision: number;
  stable_text: string;
  unstable_text: string;
  speaker_hint?: string;
  audio_end_ms: number;
  latency_ms?: number;
  queue_ms?: number;
  rtf?: number;
}

export interface WordInfo {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string;
  confidence?: number;
  overlap?: boolean;
}

export interface FinalEvent {
  type: "transcript.final";
  utterance_id: string;
  revision?: number;
  text: string;
  words?: WordInfo[];
  context_hits?: string[];
  audio_start_ms?: number;
  audio_end_ms?: number;
  authoritative?: boolean;
  finalization_status?: "pending" | "authoritative" | "fallback";
  speaker_turns?: WordInfo[];
  latency_ms?: number;
  queue_ms?: number;
  rtf?: number;
}

export type TranscriptSource = "microphone" | "file";
export type TranscriptionStatus = "recording" | "completed" | "interrupted" | "failed";

export interface TranscriptionMetrics {
  ttft_ms?: number | null;
  stable_latency_p95_ms?: number | null;
  queue_p95_ms?: number | null;
  rewrite_rate?: number | null;
  rtf?: number | null;
  context_hits?: number | null;
}

export interface TranscriptionSession {
  id: string;
  title: string;
  title_customized: boolean;
  status: TranscriptionStatus;
  source: TranscriptSource;
  processing_mode: ProcessingMode;
  model_id: string;
  final_model_id: string | null;
  catalog_revision: string;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  duration_ms: number | null;
  metrics: TranscriptionMetrics;
  expires_at: string;
  created_at: string;
  updated_at: string;
  utterance_count: number;
}

export interface TranscriptUtterance {
  id: string;
  session_id: string;
  utterance_id: string;
  revision: number;
  sequence: number;
  speaker: string;
  text: string;
  words: WordInfo[];
  context_hits: string[];
  audio_start_ms: number;
  audio_end_ms: number;
  latency_ms: number | null;
  queue_ms: number | null;
  rtf: number | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptionDetail extends TranscriptionSession {
  utterances: TranscriptUtterance[];
}

export interface TranscriptionList {
  items: TranscriptionSession[];
  meta: {
    totalCount: number;
    pageSize: number;
    nextCursor: string | null;
  };
}

export interface PersistUtteranceInput {
  revision: number;
  text: string;
  words: WordInfo[];
  context_hits: string[];
  audio_start_ms?: number;
  audio_end_ms: number;
  latency_ms: number | null;
  queue_ms: number | null;
  rtf: number | null;
}
