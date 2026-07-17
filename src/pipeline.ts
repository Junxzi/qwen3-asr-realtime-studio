import type {
  PipelineLogEntry,
  PipelineNodeId,
  PipelineStageEvent,
  PipelineStatus,
  PipelineWireStatus,
} from "./types";

const PIPELINE_NODE_IDS = new Set<PipelineNodeId>([
  "audio_ingest",
  "vad",
  "context_asr",
  "streaming_sortformer",
  "endpoint",
  "lab_finalizer",
  "replace_result",
  "persist",
]);

const PIPELINE_WIRE_STATUSES = new Set<PipelineWireStatus>([
  "queued",
  "running",
  "completed",
  "fallback",
  "failed",
  "skipped",
]);

export interface PipelineStageSnapshot {
  status: PipelineStatus;
  receivedAt: string;
  utteranceId: string;
  audioEndMs: number | null;
  elapsedMs: number | null;
  detailCode: string | null;
}

export interface PipelineUtteranceSnapshot {
  id: string;
  stages: Partial<Record<PipelineNodeId, PipelineStageSnapshot>>;
}

export interface PipelineState {
  pipelineId: string | null;
  latestWorkerSeq: number;
  latestWorkerUtteranceId: string | null;
  latestUtteranceId: string | null;
  utterances: Record<string, PipelineUtteranceSnapshot>;
  log: PipelineLogEntry[];
}

export interface ClientPipelineEvent {
  utteranceId: string;
  stage: PipelineNodeId;
  status: PipelineStatus;
  receivedAt: string;
  pipelineId?: string | null;
  audioEndMs?: number | null;
  elapsedMs?: number | null;
  detailCode?: string | null;
}

export type PipelineAction =
  | { type: "reset" }
  | { type: "worker"; event: PipelineStageEvent; receivedAt: string }
  | { type: "client"; event: ClientPipelineEvent };

export const initialPipelineState: PipelineState = {
  pipelineId: null,
  latestWorkerSeq: 0,
  latestWorkerUtteranceId: null,
  latestUtteranceId: null,
  utterances: {},
  log: [],
};

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parsePipelineStageEvent(value: unknown): PipelineStageEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "pipeline.stage") return null;
  if (!Number.isInteger(candidate.seq) || Number(candidate.seq) < 1) return null;
  if (typeof candidate.pipeline_id !== "string" || !candidate.pipeline_id) return null;
  if (typeof candidate.utterance_id !== "string" || !candidate.utterance_id) return null;
  if (!PIPELINE_NODE_IDS.has(candidate.stage as PipelineNodeId)) return null;
  if (!PIPELINE_WIRE_STATUSES.has(candidate.status as PipelineWireStatus)) return null;
  if (!nullableNumber(candidate.audio_end_ms)) return null;
  if (!nullableNumber(candidate.elapsed_ms)) return null;
  if (!nullableString(candidate.detail_code)) return null;
  return candidate as unknown as PipelineStageEvent;
}

function normalizedStatus(status: PipelineWireStatus): PipelineStatus {
  return status === "skipped" ? "fallback" : status;
}

function updateStage(
  state: PipelineState,
  entry: PipelineLogEntry,
): Pick<PipelineState, "utterances" | "latestUtteranceId" | "pipelineId" | "log"> {
  const current = state.utterances[entry.utterance_id];
  const snapshot: PipelineStageSnapshot = {
    status: entry.status,
    receivedAt: entry.received_at,
    utteranceId: entry.utterance_id,
    audioEndMs: entry.audio_end_ms,
    elapsedMs: entry.elapsed_ms,
    detailCode: entry.detail_code,
  };
  return {
    pipelineId: entry.pipeline_id || state.pipelineId,
    latestUtteranceId: entry.utterance_id,
    utterances: {
      ...state.utterances,
      [entry.utterance_id]: {
        id: entry.utterance_id,
        stages: { ...current?.stages, [entry.stage]: snapshot },
      },
    },
    log: [entry, ...state.log].slice(0, 60),
  };
}

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  if (action.type === "reset") return initialPipelineState;
  if (action.type === "worker") {
    if (action.event.seq <= state.latestWorkerSeq) return state;
    const entry: PipelineLogEntry = {
      ...action.event,
      status: normalizedStatus(action.event.status),
      received_at: action.receivedAt,
      source: "worker",
    };
    return {
      ...state,
      ...updateStage(state, entry),
      latestWorkerSeq: action.event.seq,
      latestWorkerUtteranceId: action.event.utterance_id,
    };
  }

  const entry: PipelineLogEntry = {
    type: "pipeline.stage",
    seq: null,
    pipeline_id: action.event.pipelineId || state.pipelineId || "client",
    utterance_id: action.event.utteranceId,
    stage: action.event.stage,
    status: action.event.status,
    audio_end_ms: action.event.audioEndMs ?? null,
    elapsed_ms: action.event.elapsedMs ?? null,
    detail_code: action.event.detailCode ?? null,
    received_at: action.event.receivedAt,
    source: "client",
  };
  const updated = updateStage(state, entry);
  return {
    ...state,
    ...updated,
    latestUtteranceId: state.latestWorkerUtteranceId || updated.latestUtteranceId,
  };
}

export function latestPipelineStages(state: PipelineState) {
  const latest: Partial<Record<PipelineNodeId, PipelineStageSnapshot>> = {};
  for (const entry of state.log) {
    if (latest[entry.stage]) continue;
    latest[entry.stage] = {
      status: entry.status,
      receivedAt: entry.received_at,
      utteranceId: entry.utterance_id,
      audioEndMs: entry.audio_end_ms,
      elapsedMs: entry.elapsed_ms,
      detailCode: entry.detail_code,
    };
  }
  return latest;
}

const STATUS_LABELS: Record<PipelineStatus, string> = {
  waiting: "待機",
  queued: "待機列",
  running: "実行中",
  completed: "完了",
  fallback: "代替結果",
  failed: "失敗",
};

const DETAIL_LABELS: Record<string, string> = {
  speech_started: "発話を検出",
  silence_480ms: "480msの無音を検出",
  max_utterance: "発話の上限で区切りました",
  input_end: "入力終了で確定",
  file_upload: "音声ファイルを受信",
  batch_request: "高精度モデルへ送信",
  batch_response: "高精度モデルから受信",
  authoritative_final: "最終結果へ置換",
  save_started: "Railwayへ保存中",
  save_completed: "Railwayへ保存済み",
  outbox_queued: "端末内の保存待ちへ追加",
  batch_failed: "高精度モデルの処理に失敗",
};

export function pipelineStatusLabel(status: PipelineStatus) {
  return STATUS_LABELS[status];
}

export function pipelineDetailLabel(detailCode: string | null) {
  if (!detailCode) return null;
  return DETAIL_LABELS[detailCode] || null;
}
