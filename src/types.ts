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
  };
  service: {
    url: string;
    websocketUrl: string;
    batchUrl: string;
    ready: boolean;
    health?: HealthInfo;
    message?: string;
  };
  operation?: { id: string; kind: "start" | "stop"; requestedAt: string } | null;
  checkedAt: string;
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
}

export interface AsrModelCatalog {
  items: AsrModel[];
  default_model_id: string;
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
  audio_end_ms?: number;
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
  model_id: string;
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
  audio_end_ms: number;
  latency_ms: number | null;
  queue_ms: number | null;
  rtf: number | null;
}
