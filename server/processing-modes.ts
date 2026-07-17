import {
  DEFAULT_ASR_MODEL_ID,
  FINALIZER_ASR_MODEL_ID,
  findAsrModel,
  type AsrInputMode,
  type AsrRuntime,
} from "./asr-models.js";

export type ProcessingMode = "realtime" | "batch" | "hybrid";

export interface ProcessingAssignmentProfile {
  purpose: AsrRuntime;
  model_id: string;
}

export interface PipelineNode {
  id: string;
  label: string;
}

export interface PipelineEdge {
  from: string;
  to: string;
}

export interface ProcessingProfile {
  id: ProcessingMode;
  display_name: string;
  description: string;
  input_modes: AsrInputMode[];
  primary_model_id: string;
  final_model_id: string | null;
  assignments: ProcessingAssignmentProfile[];
  availability: {
    selectable: boolean;
    configured: boolean | null;
    provisionable: boolean | null;
    validated: boolean;
    status: "configured" | "provisionable" | "setup_required" | "unknown";
  };
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export const DEFAULT_PROCESSING_MODE: ProcessingMode = "realtime";

const PROFILES = [
  {
    id: "realtime",
    display_name: "高速リアルタイム",
    description: "Context Full-FTとStreaming Sortformerで発話中から表示します",
    input_modes: ["microphone", "file"],
    primary_model_id: DEFAULT_ASR_MODEL_ID,
    final_model_id: null,
    assignments: [{ purpose: "realtime", model_id: DEFAULT_ASR_MODEL_ID }],
    nodes: [
      { id: "audio_ingest", label: "音声入力" },
      { id: "context_asr", label: "Context Full-FT 1.7B" },
      { id: "streaming_sortformer", label: "Streaming Sortformer" },
      { id: "vad", label: "VAD" },
      { id: "endpoint", label: "発話を確定" },
      { id: "persist", label: "確定結果を保存" },
    ],
    edges: [
      { from: "audio_ingest", to: "context_asr" },
      { from: "audio_ingest", to: "streaming_sortformer" },
      { from: "audio_ingest", to: "vad" },
      { from: "context_asr", to: "endpoint" },
      { from: "streaming_sortformer", to: "endpoint" },
      { from: "vad", to: "endpoint" },
      { from: "endpoint", to: "persist" },
    ],
  },
  {
    id: "batch",
    display_name: "高精度ファイル",
    description: "lab_asr_diarization_v1で音声ファイルを一括処理します",
    input_modes: ["file"],
    primary_model_id: FINALIZER_ASR_MODEL_ID,
    final_model_id: null,
    assignments: [{ purpose: "batch", model_id: FINALIZER_ASR_MODEL_ID }],
    nodes: [
      { id: "audio_ingest", label: "音声ファイル" },
      { id: "lab_finalizer", label: "lab_asr_diarization_v1" },
      { id: "endpoint", label: "話者付き最終結果" },
      { id: "persist", label: "確定結果を保存" },
    ],
    edges: [
      { from: "audio_ingest", to: "lab_finalizer" },
      { from: "lab_finalizer", to: "endpoint" },
      { from: "endpoint", to: "persist" },
    ],
  },
  {
    id: "hybrid",
    display_name: "ハイブリッド",
    description: "発話中はリアルタイム表示し、VAD確定後に話者付き最終結果へ置き換えます",
    input_modes: ["microphone", "file"],
    primary_model_id: DEFAULT_ASR_MODEL_ID,
    final_model_id: FINALIZER_ASR_MODEL_ID,
    assignments: [
      { purpose: "realtime", model_id: DEFAULT_ASR_MODEL_ID },
      { purpose: "batch", model_id: FINALIZER_ASR_MODEL_ID },
    ],
    nodes: [
      { id: "audio_ingest", label: "音声入力" },
      { id: "context_asr", label: "Context Full-FT 1.7B" },
      { id: "streaming_sortformer", label: "Streaming Sortformer" },
      { id: "vad", label: "VAD（480ms無音）" },
      { id: "endpoint", label: "発話を確定" },
      { id: "lab_finalizer", label: "lab_asr_diarization_v1" },
      { id: "replace_result", label: "最終結果で置換" },
      { id: "persist", label: "確定結果を保存" },
    ],
    edges: [
      { from: "audio_ingest", to: "context_asr" },
      { from: "audio_ingest", to: "streaming_sortformer" },
      { from: "audio_ingest", to: "vad" },
      { from: "vad", to: "endpoint" },
      { from: "endpoint", to: "lab_finalizer" },
      { from: "context_asr", to: "replace_result" },
      { from: "streaming_sortformer", to: "replace_result" },
      { from: "lab_finalizer", to: "replace_result" },
      { from: "replace_result", to: "persist" },
    ],
  },
] as const satisfies readonly Omit<ProcessingProfile, "availability">[];

interface ProcessingAvailabilitySource {
  workers: readonly {
    enabled: boolean;
    modelId: string;
    runtime: AsrRuntime;
  }[];
  modelTemplates: readonly {
    modelId: string;
    runtime: AsrRuntime;
  }[];
  canProvision: boolean;
}

function cloneProfile(
  profile: Omit<ProcessingProfile, "availability">,
  source?: ProcessingAvailabilitySource,
): ProcessingProfile {
  const configured = source
    ? profile.assignments.every((assignment) => source.workers.some((worker) => (
        worker.enabled
        && worker.modelId === assignment.model_id
        && worker.runtime === assignment.purpose
      )))
    : null;
  const provisionable = source
    ? profile.assignments.every((assignment) => (
        source.workers.some((worker) => (
          worker.enabled
          && worker.modelId === assignment.model_id
          && worker.runtime === assignment.purpose
        ))
        || (source.canProvision && source.modelTemplates.some((template) => (
          template.modelId === assignment.model_id && template.runtime === assignment.purpose
        )))
      ))
    : null;
  const validated = profile.assignments.every((assignment) => (
    findAsrModel(assignment.model_id)?.integration_status === "ready"
  ));
  return {
    ...profile,
    input_modes: [...profile.input_modes],
    assignments: profile.assignments.map((assignment) => ({ ...assignment })),
    availability: {
      selectable: true,
      configured,
      provisionable,
      validated,
      status: configured
        ? "configured"
        : provisionable ? "provisionable" : source ? "setup_required" : "unknown",
    },
    nodes: profile.nodes.map((node) => ({ ...node })),
    edges: profile.edges.map((edge) => ({ ...edge })),
  };
}

export function listProcessingProfiles(source?: ProcessingAvailabilitySource) {
  return PROFILES.map((profile) => cloneProfile(profile, source));
}

export function findProcessingProfile(mode: ProcessingMode) {
  const profile = PROFILES.find((candidate) => candidate.id === mode);
  return profile ? cloneProfile(profile) : undefined;
}

export function inferProcessingMode(modelId?: string): ProcessingMode {
  if (!modelId) return DEFAULT_PROCESSING_MODE;
  return findAsrModel(modelId)?.runtime === "batch" ? "batch" : DEFAULT_PROCESSING_MODE;
}

export function assignmentForPurpose(mode: ProcessingMode, purpose: AsrRuntime) {
  return PROFILES.find((profile) => profile.id === mode)?.assignments
    .find((assignment) => assignment.purpose === purpose);
}
