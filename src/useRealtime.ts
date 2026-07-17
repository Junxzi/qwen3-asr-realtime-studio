import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";
import {
  appendPcmSamples,
  decodeAudioFile,
  downsample,
  floatToPcm,
  MIN_FRAME_SAMPLES,
  PcmTimelineBuffer,
  pcmS16leToWav,
  SAMPLE_RATE,
  sessionStart,
} from "./audio";
import { assertAssignmentMatches, requireAssignmentConnection } from "./assignment";
import {
  initialPipelineState,
  parsePipelineStageEvent,
  pipelineReducer,
  type ClientPipelineEvent,
} from "./pipeline";
import { FinalizationDrain } from "./realtimeFinalization";
import type {
  AsrModel,
  FinalEvent,
  InferenceAssignment,
  PartialEvent,
  ProcessingProfile,
  TranscriptionSession,
  WordInfo,
} from "./types";

type Connection = "disconnected" | "connecting" | "connected" | "error";

export const BATCH_REQUEST_TIMEOUT_MS = 180_000;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function enqueueSerial(previous: Promise<void>, task: () => void | Promise<void>) {
  return previous.catch(() => undefined).then(task);
}

export function scheduleHybridFinalization(
  previous: Promise<void>,
  persistProvisional: () => void | Promise<void>,
  finalize: () => void | Promise<void>,
) {
  return {
    provisionalDelivery: Promise.resolve().then(persistProvisional),
    queuedFinalization: enqueueSerial(previous, finalize),
  };
}

export function scheduleHybridFallbackDelivery(
  provisional: FinalEvent,
  sessionId: string,
  deliver?: (event: FinalEvent, sessionId: string) => void | Promise<void>,
) {
  const fallback = hybridFallbackFinal(provisional);
  return {
    fallback,
    delivery: Promise.resolve().then(() => deliver?.(fallback, sessionId)),
  };
}

export function createBatchRequestDeadline(
  parentSignal?: AbortSignal,
  timeoutMs = BATCH_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const detachParent = () => {
    parentSignal?.removeEventListener("abort", abortFromParent);
  };
  const clearTimer = () => {
    if (timer === undefined) return;
    globalThis.clearTimeout(timer);
    timer = undefined;
  };
  const abortFromParent = () => {
    if (controller.signal.aborted) return;
    clearTimer();
    detachParent();
    controller.abort(parentSignal?.reason ?? new DOMException("音声処理を中止しました", "AbortError"));
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      detachParent();
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException("高精度モデルが180秒以内に応答しませんでした", "TimeoutError"));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer();
      detachParent();
    },
  };
}

export async function runBatchRequestWithDeadline<T>(
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = BATCH_REQUEST_TIMEOUT_MS,
) {
  const deadline = createBatchRequestDeadline(parentSignal, timeoutMs);
  try {
    return await operation(deadline.signal);
  } catch (caught) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw caught;
  } finally {
    deadline.dispose();
  }
}

export async function refreshHybridBatchAssignment(
  session: TranscriptionSession,
  modelId: string,
  signal?: AbortSignal,
  requestAssignment = api.requestAssignment,
) {
  const assignment = await requestAssignment(session.id, "batch", signal);
  assertAssignmentMatches(assignment, session, modelId);
  requireAssignmentConnection(assignment, "batch");
  return assignment;
}

function createBatchSpeakerNormalizer() {
  const speakerOrder = new Map<string, number>();
  return (speaker: string | undefined, index: number) => {
    const key = speaker?.trim().toLowerCase() || `unknown-${index}`;
    const workerLabel = key.match(/^(?:speaker|spk)_(\d+)$/);
    if (workerLabel) {
      // Both Studio workers expose zero-based speaker_0/1 labels. Keep the
      // public UI/API contract one-based even when only speaker_1 is present.
      return `speaker_${Math.min(Number(workerLabel[1]) + 1, 2)}`;
    }
    if (!speakerOrder.has(key)) {
      // The Studio PoC is intentionally capped at two telephone speakers.
      speakerOrder.set(key, Math.min(speakerOrder.size + 1, 2));
    }
    return `speaker_${speakerOrder.get(key)}`;
  };
}

function oneBasedWorkerSpeaker(speaker?: string) {
  const match = speaker?.trim().toLowerCase().match(/^(?:speaker|spk)_(\d+)$/);
  if (!match) return "speaker_1";
  return `speaker_${Math.min(Number(match[1]) + 1, 2)}`;
}

function oneBasedFinalSpeaker(speaker?: string) {
  const match = speaker?.trim().toLowerCase().match(/^(?:speaker|spk)_(\d+)$/);
  if (!match) return "speaker_1";
  const numeric = Number(match[1]);
  return `speaker_${Math.min(Math.max(numeric, 1), 2)}`;
}

export function normalizeRealtimeFinalSpeakers(event: FinalEvent): FinalEvent {
  const normalize = (word: WordInfo): WordInfo => ({
    ...word,
    speaker: oneBasedWorkerSpeaker(word.speaker),
  });
  return {
    ...event,
    words: event.words?.map(normalize),
    speaker_turns: event.speaker_turns?.map(normalize),
  };
}

function overlapMs(left: WordInfo, right: WordInfo) {
  return Math.max(0, Math.min(left.end_ms, right.end_ms) - Math.max(left.start_ms, right.start_ms));
}

function projectBatchSpeakers(words: WordInfo[], provisionalWords: WordInfo[]) {
  const provisional = provisionalWords.map((word) => ({
    ...word,
    speaker: oneBasedFinalSpeaker(word.speaker),
  }));
  const totalBySpeaker = new Map<string, number>();
  for (const word of provisional) {
    totalBySpeaker.set(
      word.speaker,
      (totalBySpeaker.get(word.speaker) || 0) + Math.max(0, word.end_ms - word.start_ms),
    );
  }
  const dominantSpeaker = [...totalBySpeaker.entries()]
    .sort(([leftSpeaker, leftMs], [rightSpeaker, rightMs]) => (
      rightMs - leftMs || leftSpeaker.localeCompare(rightSpeaker)
    ))[0]?.[0];

  const batchSpeakers = [...new Set(words.map((word) => oneBasedFinalSpeaker(word.speaker)))].sort();
  const provisionalSpeakers = [...totalBySpeaker.keys()].sort();
  const overlapByIdentity = new Map<string, Map<string, number>>();
  for (const word of words) {
    const batchSpeaker = oneBasedFinalSpeaker(word.speaker);
    const scores = overlapByIdentity.get(batchSpeaker) || new Map<string, number>();
    for (const candidate of provisional) {
      const overlap = overlapMs(word, candidate);
      if (overlap > 0) {
        scores.set(candidate.speaker, (scores.get(candidate.speaker) || 0) + overlap);
      }
    }
    overlapByIdentity.set(batchSpeaker, scores);
  }

  const projectedSpeaker = new Map<string, string>();
  if (provisionalSpeakers.length === 1) {
    const knownSpeaker = provisionalSpeakers[0]!;
    if (batchSpeakers.length === 1) {
      projectedSpeaker.set(batchSpeakers[0]!, knownSpeaker);
    } else if (batchSpeakers.length > 1) {
      const matchingBatchSpeaker = [...batchSpeakers].sort((left, right) => {
        const overlapDifference = (
          overlapByIdentity.get(right)?.get(knownSpeaker) || 0
        ) - (
          overlapByIdentity.get(left)?.get(knownSpeaker) || 0
        );
        if (overlapDifference) return overlapDifference;
        const rightKeepsLabel = right === knownSpeaker ? 1 : 0;
        const leftKeepsLabel = left === knownSpeaker ? 1 : 0;
        return rightKeepsLabel - leftKeepsLabel || left.localeCompare(right);
      })[0]!;
      const otherSpeaker = knownSpeaker === "speaker_1" ? "speaker_2" : "speaker_1";
      projectedSpeaker.set(matchingBatchSpeaker, knownSpeaker);
      for (const batchSpeaker of batchSpeakers) {
        if (batchSpeaker !== matchingBatchSpeaker) projectedSpeaker.set(batchSpeaker, otherSpeaker);
      }
    }
  } else if (batchSpeakers.length === 2 && provisionalSpeakers.length === 2) {
    const [batchA, batchB] = batchSpeakers;
    const [provisionalA, provisionalB] = provisionalSpeakers;
    const score = (batchSpeaker: string, provisionalSpeaker: string) => (
      overlapByIdentity.get(batchSpeaker)?.get(provisionalSpeaker) || 0
    );
    const direct = score(batchA!, provisionalA!) + score(batchB!, provisionalB!);
    const crossed = score(batchA!, provisionalB!) + score(batchB!, provisionalA!);
    if (crossed > direct) {
      projectedSpeaker.set(batchA!, provisionalB!);
      projectedSpeaker.set(batchB!, provisionalA!);
    } else {
      projectedSpeaker.set(batchA!, provisionalA!);
      projectedSpeaker.set(batchB!, provisionalB!);
    }
  } else {
    for (const batchSpeaker of batchSpeakers) {
      const best = [...(overlapByIdentity.get(batchSpeaker)?.entries() || [])]
        .sort(([leftSpeaker, leftMs], [rightSpeaker, rightMs]) => (
          rightMs - leftMs || leftSpeaker.localeCompare(rightSpeaker)
        ))[0];
      if (best?.[1]) projectedSpeaker.set(batchSpeaker, best[0]);
    }
  }

  return words.map((word) => {
    const batchSpeaker = oneBasedFinalSpeaker(word.speaker);
    return {
      ...word,
      speaker: projectedSpeaker.get(batchSpeaker)
        || (provisionalSpeakers.includes(batchSpeaker) ? batchSpeaker : undefined)
        || dominantSpeaker
        || batchSpeaker,
    };
  });
}

interface BatchResponse {
  utterance_id?: string;
  text?: string;
  duration?: number;
  wall?: number;
  rtf?: number;
  utterances?: Array<{
    utterance_id?: string;
    text: string;
    speaker?: string;
    start_ms?: number;
    end_ms?: number;
    confidence?: number;
  }>;
  turns?: Array<{
    speaker?: string;
    text: string;
    start_ms?: number;
    end_ms?: number;
    confidence?: number;
  }>;
  error?: string;
}

interface HybridFinalizationJob {
  provisional: FinalEvent;
  session: TranscriptionSession;
  assignment: InferenceAssignment | null;
  modelId: string | null;
  pipelineId: string;
  generation: number;
  signal: AbortSignal | null;
  audio: Blob | null;
  captureError: Error | null;
}

export function isCurrentHybridFinalization(
  job: Pick<HybridFinalizationJob, "generation" | "session">,
  generation: number,
  activeSessionId?: string,
) {
  return job.generation === generation && job.session.id === activeSessionId;
}

export function batchFinals(payload: BatchResponse): FinalEvent[] {
  const durationMs = Math.max(0, Math.round((payload.duration || 0) * 1000));
  const latencyMs = Number.isFinite(payload.wall) ? Math.round(payload.wall! * 1000) : undefined;
  const rtf = Number.isFinite(payload.rtf)
    ? payload.rtf
    : payload.duration && payload.wall
      ? payload.wall / payload.duration
      : undefined;

  const utterances = payload.utterances?.length
    ? payload.utterances
    : payload.turns?.map((turn, index) => ({
      ...turn,
      utterance_id: payload.utterance_id
        ? `${payload.utterance_id}:${index + 1}`
        : undefined,
    }));

  if (utterances?.length) {
    const normalizeSpeaker = createBatchSpeakerNormalizer();
    return utterances.map<FinalEvent>((utterance, index) => {
      const startMs = Math.max(0, Math.round(utterance.start_ms ?? 0));
      const endMs = Math.max(startMs, Math.round(utterance.end_ms ?? durationMs));
      const speaker = normalizeSpeaker(utterance.speaker, index);
      return {
        type: "transcript.final",
        utterance_id: utterance.utterance_id || `batch-${index + 1}`,
        revision: 0,
        text: utterance.text.trim(),
        words: [{
          text: utterance.text.trim(),
          start_ms: 0,
          end_ms: endMs - startMs,
          speaker,
          confidence: utterance.confidence,
        }],
        audio_start_ms: startMs,
        audio_end_ms: endMs,
        latency_ms: latencyMs,
        queue_ms: 0,
        rtf,
      };
    }).filter((event) => event.text);
  }

  const text = (payload.text || "").trim();
  if (!text) return [];
  const marker = /(?:<\|spk_(\d+)\|>|\[spk_(\d+)\])/g;
  const matches = [...text.matchAll(marker)];
  const normalizeSpeaker = createBatchSpeakerNormalizer();
  const segments = matches.length
    ? matches.map((match, index) => ({
      speaker: normalizeSpeaker(`spk_${match[1] ?? match[2]}`, index),
      text: text.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
    })).filter((segment) => segment.text)
    : [{ speaker: "speaker_1", text }];
  const totalWeight = segments.reduce((sum, segment) => sum + Math.max(1, segment.text.length), 0);
  let elapsedWeight = 0;
  return segments.map<FinalEvent>((segment, index) => {
    const startMs = totalWeight ? Math.round(durationMs * elapsedWeight / totalWeight) : 0;
    elapsedWeight += Math.max(1, segment.text.length);
    const endMs = totalWeight ? Math.round(durationMs * elapsedWeight / totalWeight) : durationMs;
    return {
      type: "transcript.final",
      utterance_id: `batch-${index + 1}`,
      revision: 0,
      text: segment.text,
      words: [{
        text: segment.text,
        start_ms: 0,
        end_ms: endMs - startMs,
        speaker: segment.speaker,
      }],
      audio_start_ms: startMs,
      audio_end_ms: endMs,
      latency_ms: latencyMs,
      queue_ms: 0,
      rtf,
    };
  });
}

export function hybridFinalFromBatch(payload: BatchResponse, provisional: FinalEvent): FinalEvent {
  const batchEvents = batchFinals(payload);
  if (!batchEvents.length) throw new Error("高精度モデルから文字起こし結果が返りませんでした");
  const text = batchEvents.map((event) => event.text.trim()).filter(Boolean).join("\n");
  const relativeWords = batchEvents.flatMap((event) => {
    const segmentOffsetMs = event.audio_start_ms ?? 0;
    return (event.words || []).map((word) => ({
      ...word,
      start_ms: segmentOffsetMs + word.start_ms,
      end_ms: segmentOffsetMs + word.end_ms,
    }));
  });
  const words = projectBatchSpeakers(relativeWords, provisional.words || []);
  const latencyValues = batchEvents.map((event) => event.latency_ms).filter((value): value is number => Number.isFinite(value));
  const queueValues = batchEvents.map((event) => event.queue_ms).filter((value): value is number => Number.isFinite(value));
  const rtfValues = batchEvents.map((event) => event.rtf).filter((value): value is number => Number.isFinite(value));
  return {
    type: "transcript.final",
    utterance_id: provisional.utterance_id,
    revision: (provisional.revision ?? 0) + 1,
    text,
    words,
    speaker_turns: words,
    context_hits: provisional.context_hits || [],
    audio_start_ms: provisional.audio_start_ms ?? 0,
    audio_end_ms: provisional.audio_end_ms,
    authoritative: true,
    finalization_status: "authoritative",
    latency_ms: latencyValues.length ? Math.max(...latencyValues) : undefined,
    queue_ms: queueValues.length ? Math.max(...queueValues) : undefined,
    rtf: rtfValues.length ? rtfValues.reduce((sum, value) => sum + value, 0) / rtfValues.length : undefined,
  };
}

export function hybridFallbackFinal(provisional: FinalEvent): FinalEvent {
  return {
    ...provisional,
    authoritative: false,
    finalization_status: "fallback",
  };
}

function finalAuthorityRank(event: FinalEvent) {
  if (event.finalization_status === "authoritative" || event.authoritative === true) return 2;
  if (event.finalization_status === "fallback") return 1;
  return 0;
}

export function shouldUpsertFinal(existing: FinalEvent, incoming: FinalEvent) {
  const existingRevision = existing.revision ?? 0;
  const incomingRevision = incoming.revision ?? 0;
  if (incomingRevision !== existingRevision) return incomingRevision > existingRevision;
  return finalAuthorityRank(incoming) > finalAuthorityRank(existing);
}

export function useRealtime(
  model?: AsrModel,
  onFinal?: (event: FinalEvent, sessionId: string) => void | Promise<void>,
  onUnexpectedDisconnect?: (error: Error, sessionId: string) => void | Promise<void>,
  processingProfile?: ProcessingProfile,
) {
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [capturing, setCapturing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizationBlocked, setFinalizationBlocked] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("未選択");
  const [partial, setPartial] = useState<PartialEvent | null>(null);
  const [finals, setFinals] = useState<FinalEvent[]>([]);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [pipeline, dispatchPipeline] = useReducer(pipelineReducer, initialPipelineState);
  const socketRef = useRef<WebSocket | null>(null);
  const socketKeyRef = useRef<string | null>(null);
  const expectedCloseSocketsRef = useRef(new WeakSet<WebSocket>());
  const readyRef = useRef(false);
  const inputEndSupportedRef = useRef(false);
  const capturingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const microphoneBufferRef = useRef(new Float32Array());
  const captureStartedAtRef = useRef<number | null>(null);
  const firstTokenRef = useRef<number | null>(null);
  const finalsRef = useRef<FinalEvent[]>([]);
  const partialRef = useRef<PartialEvent | null>(null);
  const timelineRef = useRef(new PcmTimelineBuffer());
  const batchAssignmentRef = useRef<InferenceAssignment | null>(null);
  const activeSessionRef = useRef<TranscriptionSession | null>(null);
  const finalizerAbortRef = useRef<AbortController | null>(null);
  const hybridGenerationRef = useRef(0);
  const hybridFinalizedRef = useRef(new Set<string>());
  const finalizerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finalizationDrainRef = useRef<FinalizationDrain | null>(null);
  const finalDeliveryTasksRef = useRef(new Set<Promise<void>>());
  const terminalFailureRef = useRef<Error | null>(null);
  const onFinalRef = useRef(onFinal);
  const onUnexpectedDisconnectRef = useRef(onUnexpectedDisconnect);
  const processingProfileRef = useRef(processingProfile);
  onFinalRef.current = onFinal;
  onUnexpectedDisconnectRef.current = onUnexpectedDisconnect;
  processingProfileRef.current = processingProfile;

  const addEvent = useCallback((message: string) => {
    setEvents((current) => [message, ...current].slice(0, 20));
  }, []);

  const recordPipeline = useCallback((event: Omit<ClientPipelineEvent, "receivedAt">) => {
    dispatchPipeline({
      type: "client",
      event: { ...event, receivedAt: new Date().toISOString() },
    });
  }, []);

  const trackFinalDelivery = useCallback((delivery: void | Promise<void>) => {
    const task = Promise.resolve(delivery);
    finalDeliveryTasksRef.current.add(task);
    void task.then(
      () => finalDeliveryTasksRef.current.delete(task),
      () => finalDeliveryTasksRef.current.delete(task),
    );
  }, []);

  const waitForFinalDeliveries = useCallback(async () => {
    while (finalDeliveryTasksRef.current.size) {
      await Promise.allSettled([...finalDeliveryTasksRef.current]);
    }
  }, []);

  const releaseAudio = useCallback(async () => {
    workletRef.current?.disconnect();
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioContextRef.current && audioContextRef.current.state !== "closed") await audioContextRef.current.close();
    audioContextRef.current = null;
    streamRef.current = null;
    workletRef.current = null;
    sourceRef.current = null;
    gainRef.current = null;
    microphoneBufferRef.current = new Float32Array();
  }, []);

  const sendSamples = useCallback((samples: Float32Array) => {
    const socket = socketRef.current;
    if (!readyRef.current || socket?.readyState !== WebSocket.OPEN || samples.length < SAMPLE_RATE * 0.02) return;
    const pcm = floatToPcm(samples);
    if (processingProfileRef.current?.id === "hybrid") timelineRef.current.append(pcm);
    socket.send(pcm);
  }, []);

  const upsertFinal = useCallback((event: FinalEvent) => {
    const currentFinals = finalsRef.current;
    const existing = currentFinals.findIndex((item) => item.utterance_id === event.utterance_id);
    if (existing >= 0 && !shouldUpsertFinal(currentFinals[existing]!, event)) return false;
    const nextFinals = existing < 0 ? [...currentFinals, event] : [...currentFinals];
    if (existing >= 0) nextFinals[existing] = event;
    finalsRef.current = nextFinals;
    setFinals(nextFinals);
    if (partialRef.current?.utterance_id === event.utterance_id) {
      partialRef.current = null;
      setPartial(null);
    }
    return true;
  }, []);

  const postBatchAudio = useCallback(async ({
    session,
    assignment,
    audio,
    filename,
    modelId,
    utteranceId,
    requestUtteranceId,
    signal,
    refreshAssignment = false,
    pipelineId,
  }: {
    session: TranscriptionSession;
    assignment: InferenceAssignment | null;
    audio: Blob;
    filename: string;
    modelId: string;
    utteranceId: string;
    requestUtteranceId?: string;
    signal?: AbortSignal;
    refreshAssignment?: boolean;
    pipelineId?: string;
  }) => {
    const deadline = createBatchRequestDeadline(signal);
    try {
      let currentAssignment = assignment;
      if (refreshAssignment) {
        currentAssignment = await refreshHybridBatchAssignment(
          session,
          modelId,
          deadline.signal,
        );
      }
      if (!currentAssignment) {
        throw new Error("高精度モデルのGPU割り当てを取得できませんでした");
      }
      const connectionInfo = requireAssignmentConnection(currentAssignment, "batch");
      const form = new FormData();
      form.append("audio", audio, filename);
      form.append("session_id", session.id);
      form.append("model_id", modelId);
      form.append("max_new_tokens", "800");
      if (requestUtteranceId) form.append("utterance_id", requestUtteranceId);
      recordPipeline({
        utteranceId,
        stage: "lab_finalizer",
        status: "running",
        pipelineId,
        detailCode: "batch_request",
      });
      const response = await fetch(connectionInfo.batch_url!, {
        method: "POST",
        headers: { Authorization: `Bearer ${connectionInfo.ticket}` },
        body: form,
        signal: deadline.signal,
      });
      const payload = await response.json().catch(() => ({})) as BatchResponse;
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `ファイル文字起こしに失敗しました (HTTP ${response.status})`);
      }
      recordPipeline({
        utteranceId,
        stage: "lab_finalizer",
        status: "completed",
        pipelineId,
        detailCode: "batch_response",
      });
      return payload;
    } catch (caught) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw caught;
    } finally {
      deadline.dispose();
    }
  }, [recordPipeline]);

  const finalizeHybridUtterance = useCallback(async (job: HybridFinalizationJob) => {
    const {
      provisional,
      session,
      assignment,
      modelId,
      pipelineId,
      signal,
      audio,
      captureError,
    } = job;
    const isCurrent = () => isCurrentHybridFinalization(
      job,
      hybridGenerationRef.current,
      activeSessionRef.current?.id,
    );
    if (!isCurrent()) return;
    try {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("高精度確定を中止しました", "AbortError");
      }
      if (!modelId) throw new Error("高精度モデルを特定できませんでした");
      if (captureError) throw captureError;
      if (!audio) throw new Error("高精度再推論に必要な発話音声を取得できませんでした");
      const payload = await postBatchAudio({
        session,
        assignment,
        audio,
        filename: `${provisional.utterance_id}.wav`,
        modelId,
        utteranceId: provisional.utterance_id,
        requestUtteranceId: provisional.utterance_id,
        signal: signal ?? undefined,
        refreshAssignment: true,
        pipelineId,
      });
      if (!isCurrent()) return;
      recordPipeline({
        utteranceId: provisional.utterance_id,
        stage: "replace_result",
        status: "running",
        pipelineId,
        audioEndMs: provisional.audio_end_ms,
        detailCode: "authoritative_final",
      });
      const authoritative = hybridFinalFromBatch(payload, provisional);
      upsertFinal(authoritative);
      recordPipeline({
        utteranceId: provisional.utterance_id,
        stage: "replace_result",
        status: "completed",
        pipelineId,
        audioEndMs: provisional.audio_end_ms,
        detailCode: "authoritative_final",
      });
      try {
        trackFinalDelivery(onFinalRef.current?.(authoritative, session.id));
      } catch (caught) {
        trackFinalDelivery(Promise.reject(caught));
      }
    } catch {
      if (!isCurrent()) return;
      recordPipeline({
        utteranceId: provisional.utterance_id,
        stage: "lab_finalizer",
        status: "failed",
        pipelineId,
        audioEndMs: provisional.audio_end_ms,
        detailCode: "batch_failed",
      });
      recordPipeline({
        utteranceId: provisional.utterance_id,
        stage: "replace_result",
        status: "fallback",
        pipelineId,
        audioEndMs: provisional.audio_end_ms,
        detailCode: "batch_failed",
      });
      const scheduled = scheduleHybridFallbackDelivery(
        provisional,
        session.id,
        onFinalRef.current,
      );
      upsertFinal(scheduled.fallback);
      trackFinalDelivery(scheduled.delivery);
      addEvent("高精度確定に失敗したため、リアルタイム結果を残しました");
    }
  }, [addEvent, postBatchAudio, recordPipeline, trackFinalDelivery, upsertFinal]);

  const connect = useCallback(async (session: TranscriptionSession, assignment: InferenceAssignment) => {
    const connectionInfo = requireAssignmentConnection(assignment, "realtime");
    const socketKey = `${session.id}:${assignment.id}`;
    if (
      readyRef.current
      && socketRef.current?.readyState === WebSocket.OPEN
      && socketKeyRef.current === socketKey
    ) return;
    const catalogRevision = connectionInfo.catalog_revision || session.catalog_revision;
    if (!catalogRevision) throw new Error("割り当て先GPUのContextカタログ情報を取得できませんでした");
    const previous = socketRef.current;
    socketRef.current = null;
    socketKeyRef.current = null;
    readyRef.current = false;
    inputEndSupportedRef.current = false;
    terminalFailureRef.current = null;
    if (previous) {
      expectedCloseSocketsRef.current.add(previous);
      previous.close();
    }
    await releaseAudio();
    setConnection("connecting");
    setError("");
    setFinalizationBlocked(false);
    const socket = new WebSocket(connectionInfo.websocket_url!);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socketKeyRef.current = socketKey;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let readySeen = false;
      let terminalNotified = false;
      let protocolFailure: Error | null = null;
      const isCurrent = () => socketRef.current === socket && socketKeyRef.current === socketKey;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const notifyTerminalOnce = (failure: Error) => {
        if (
          !readySeen
          || terminalNotified
          || expectedCloseSocketsRef.current.has(socket)
        ) return;
        terminalNotified = true;
        terminalFailureRef.current = failure;
        finalizationDrainRef.current?.fail(failure);
        try {
          const notification = onUnexpectedDisconnectRef.current?.(failure, session.id);
          if (notification) void Promise.resolve(notification).catch(() => undefined);
        } catch {
          // The socket terminal state must remain one-shot even if its observer fails.
        }
      };
      const timeout = window.setTimeout(() => {
        socket.close();
        fail(new Error("割り当て先GPUへの接続がタイムアウトしました"));
      }, 20_000);
      socket.addEventListener("open", () => {
        if (!isCurrent()) return;
        socket.send(JSON.stringify(sessionStart(
          session.id,
          catalogRevision,
          assignment.model_id || session.model_id,
          connectionInfo.ticket,
        )));
      });
      socket.addEventListener("message", (event) => {
        if (!isCurrent()) return;
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        const pipelineEvent = parsePipelineStageEvent(payload);
        if (pipelineEvent) {
          if (processingProfileRef.current?.id === "hybrid" && pipelineEvent.stage === "replace_result") {
            return;
          }
          dispatchPipeline({
            type: "worker",
            event: pipelineEvent,
            receivedAt: new Date().toISOString(),
          });
          return;
        }
        if (payload.type === "session.ready") {
          window.clearTimeout(timeout);
          settled = true;
          readySeen = true;
          readyRef.current = true;
          inputEndSupportedRef.current = payload.capabilities?.input_end === true
            || payload.input_end_supported === true;
          setConnection("connected");
          addEvent("実時間ストリームへ接続しました");
          resolve();
        } else if (payload.type === "transcript.partial") {
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          const received = payload as PartialEvent;
          const partialEvent: PartialEvent = received.speaker_hint
            ? { ...received, speaker_hint: oneBasedWorkerSpeaker(received.speaker_hint) }
            : received;
          partialRef.current = partialEvent;
          finalizationDrainRef.current?.notifyPartial(partialEvent.utterance_id);
          setPartial(partialEvent);
        } else if (payload.type === "transcript.final") {
          const received = normalizeRealtimeFinalSpeakers(payload as FinalEvent);
          const profile = processingProfileRef.current;
          const finalEvent: FinalEvent = profile?.id === "hybrid"
            ? { ...received, authoritative: false, finalization_status: "pending" }
            : received;
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          const acceptedFinal = upsertFinal(finalEvent);
          finalizationDrainRef.current?.notifyFinal(finalEvent.utterance_id);
          if (!acceptedFinal) return;
          addEvent("発話を確定しました");
          if (
            profile?.id === "hybrid"
            && !hybridFinalizedRef.current.has(finalEvent.utterance_id)
          ) {
            hybridFinalizedRef.current.add(finalEvent.utterance_id);
            recordPipeline({
              utteranceId: finalEvent.utterance_id,
              stage: "lab_finalizer",
              status: "queued",
              pipelineId: profile.id,
              audioEndMs: finalEvent.audio_end_ms,
              detailCode: "batch_request",
            });
            let audio: Blob | null = null;
            let captureError: Error | null = null;
            try {
              const startMs = finalEvent.audio_start_ms;
              const endMs = finalEvent.audio_end_ms;
              if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs! <= startMs!) {
                throw new Error("高精度再推論に必要な発話境界を取得できませんでした");
              }
              audio = pcmS16leToWav(timelineRef.current.slice(startMs!, endMs!));
            } catch (caught) {
              captureError = caught instanceof Error
                ? caught
                : new Error("高精度再推論に必要な発話音声を取得できませんでした");
            }
            const job: HybridFinalizationJob = {
              provisional: finalEvent,
              session,
              assignment: batchAssignmentRef.current,
              modelId: profile.final_model_id,
              pipelineId: profile.id,
              generation: hybridGenerationRef.current,
              signal: finalizerAbortRef.current?.signal ?? null,
              audio,
              captureError,
            };
            const { provisionalDelivery, queuedFinalization } = scheduleHybridFinalization(
              finalizerQueueRef.current,
              () => onFinalRef.current?.(finalEvent, session.id),
              () => finalizeHybridUtterance(job),
            );
            finalizerQueueRef.current = queuedFinalization;
            trackFinalDelivery(provisionalDelivery);
            trackFinalDelivery(queuedFinalization);
          } else {
            const provisionalDelivery = Promise.resolve().then(
              () => onFinalRef.current?.(finalEvent, session.id),
            );
            trackFinalDelivery(provisionalDelivery);
          }
        } else if (payload.type === "stream.finalized") {
          expectedCloseSocketsRef.current.add(socket);
          finalizationDrainRef.current?.notifyFinalized();
          addEvent("GPUからストリーム最終確定を受信しました");
        } else if (payload.type === "error") {
          protocolFailure = new Error(`${payload.code}: ${payload.message}`);
          setError(protocolFailure.message);
          setConnection("error");
          fail(protocolFailure);
          notifyTerminalOnce(protocolFailure);
          socket.close();
        }
      });
      socket.addEventListener("error", () => {
        if (!isCurrent()) return;
        const failure = new Error("割り当て先GPUとの接続でエラーが発生しました");
        setConnection("error");
        setError(failure.message);
        fail(failure);
        notifyTerminalOnce(failure);
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(timeout);
        if (!isCurrent()) return;
        const expected = expectedCloseSocketsRef.current.has(socket);
        const failure = protocolFailure || new Error("割り当て先GPUとの接続が予期せず切断されました");
        socketRef.current = null;
        socketKeyRef.current = null;
        readyRef.current = false;
        inputEndSupportedRef.current = false;
        setConnection("disconnected");
        setCapturing(false);
        capturingRef.current = false;
        setFinalizing(false);
        void releaseAudio();
        if (!expected) {
          finalizationDrainRef.current?.fail(failure);
          notifyTerminalOnce(failure);
        }
        fail(failure);
      });
    });
  }, [addEvent, finalizeHybridUtterance, recordPipeline, releaseAudio, trackFinalDelivery, upsertFinal]);

  const startMicrophone = useCallback(async (
    session: TranscriptionSession,
    assignment: InferenceAssignment,
    batchAssignment?: InferenceAssignment,
  ) => {
    try {
      const supportsMicrophone = processingProfileRef.current
        ? processingProfileRef.current.input_modes.includes("microphone")
          && processingProfileRef.current.id !== "batch"
        : model?.input_modes.includes("microphone") && model.runtime === "realtime";
      if (!supportsMicrophone) {
        throw new Error("このモデルはマイクのリアルタイム入力に対応していません");
      }
      activeSessionRef.current = session;
      batchAssignmentRef.current = batchAssignment || null;
      hybridGenerationRef.current += 1;
      finalizerAbortRef.current?.abort();
      finalizerAbortRef.current = new AbortController();
      timelineRef.current.clear();
      hybridFinalizedRef.current.clear();
      finalizerQueueRef.current = Promise.resolve();
      await connect(session, assignment);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (terminalFailureRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw terminalFailureRef.current;
      }
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.audioWorklet.addModule("/pcm-worklet.js");
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "pcm-forwarder");
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(worklet).connect(gain).connect(context.destination);
      worklet.port.onmessage = ({ data }) => {
        if (!capturingRef.current) return;
        const buffered = appendPcmSamples(
          microphoneBufferRef.current,
          downsample(new Float32Array(data), context.sampleRate),
        );
        microphoneBufferRef.current = buffered.pending;
        if (buffered.sendable.length) sendSamples(buffered.sendable);
      };
      streamRef.current = stream;
      audioContextRef.current = context;
      sourceRef.current = source;
      workletRef.current = worklet;
      gainRef.current = gain;
      capturingRef.current = true;
      captureStartedAtRef.current = performance.now();
      setCapturing(true);
      setFinalizing(false);
      setSourceLabel(stream.getAudioTracks()[0]?.label || "マイク入力");
      addEvent("マイクのストリーミングを開始しました");
    } catch (caught) {
      await releaseAudio();
      const socket = socketRef.current;
      if (socket) expectedCloseSocketsRef.current.add(socket);
      socket?.close();
      socketRef.current = null;
      socketKeyRef.current = null;
      readyRef.current = false;
      inputEndSupportedRef.current = false;
      setConnection("error");
      const failure = caught instanceof Error ? caught : new Error("マイクを開始できません");
      setError(failure.message);
      throw failure;
    }
  }, [addEvent, connect, model, releaseAudio, sendSamples]);

  const stopInput = useCallback(async () => {
    capturingRef.current = false;
    setFinalizing(true);
    const socket = socketRef.current;
    if (!readyRef.current || socket?.readyState !== WebSocket.OPEN) {
      setFinalizing(false);
      throw terminalFailureRef.current || new Error("GPUとの接続がないため発話を最終確定できません");
    }
    const supportsInputEnd = inputEndSupportedRef.current;
    const drain = new FinalizationDrain({
      mode: supportsInputEnd ? "ack" : "legacy",
      pendingUtteranceId: partialRef.current?.utterance_id,
    });
    finalizationDrainRef.current = drain;
    if (readyRef.current && microphoneBufferRef.current.length) {
      const paddedTail = new Float32Array(MIN_FRAME_SAMPLES);
      paddedTail.set(microphoneBufferRef.current);
      microphoneBufferRef.current = new Float32Array();
      sendSamples(paddedTail);
    }
    await releaseAudio();
    setCapturing(false);
    try {
      if (supportsInputEnd) {
        socket.send(JSON.stringify({ type: "input.end" }));
        addEvent("音声入力を終了し、GPUへ最終確定を要求しました");
      } else {
        addEvent("旧Workerのため最終確定はbest-effortです（最大5秒待機）");
        const silence = new Float32Array(SAMPLE_RATE * 0.1);
        for (let index = 0; index < 7; index += 1) {
          sendSamples(silence);
          await wait(100);
        }
      }
      const result = await drain.wait();
      if (result === "timeout") {
        addEvent("旧Workerから末尾finalを確認できないまま待機上限に達しました");
      }
      await waitForFinalDeliveries();
      if (terminalFailureRef.current) throw terminalFailureRef.current;
      addEvent("末尾発話の確定と保存処理を確認しました");
      setFinalizationBlocked(false);
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error("ストリームを最終確定できませんでした");
      setError(failure.message);
      setFinalizationBlocked(true);
      throw failure;
    } finally {
      if (finalizationDrainRef.current === drain) finalizationDrainRef.current = null;
      setFinalizing(false);
    }
  }, [addEvent, releaseAudio, sendSamples, waitForFinalDeliveries]);

  const startFile = useCallback(async (
    session: TranscriptionSession,
    file: File,
    assignment: InferenceAssignment,
    signal?: AbortSignal,
    batchAssignment?: InferenceAssignment,
  ) => {
    try {
      const profile = processingProfileRef.current;
      const supportsFile = profile
        ? profile.input_modes.includes("file")
        : model?.input_modes.includes("file");
      if (!supportsFile) {
        throw new Error("このモデルは音声ファイル入力に対応していません");
      }
      activeSessionRef.current = session;
      batchAssignmentRef.current = batchAssignment || (profile?.id === "batch" ? assignment : null);
      hybridGenerationRef.current += 1;
      finalizerAbortRef.current?.abort();
      finalizerAbortRef.current = new AbortController();
      timelineRef.current.clear();
      hybridFinalizedRef.current.clear();
      finalizerQueueRef.current = Promise.resolve();
      const batchMode = profile ? profile.id === "batch" : model?.runtime === "batch";
      if (batchMode) {
        const utteranceId = `${session.id}:file`;
        const modelId = profile?.primary_model_id || model?.id;
        if (!modelId) throw new Error("ファイル文字起こしモデルを特定できませんでした");
        setError("");
        setConnection("connecting");
        setCapturing(false);
        setFinalizing(true);
        setSourceLabel(file.name);
        captureStartedAtRef.current = performance.now();
        recordPipeline({
          utteranceId,
          stage: "audio_ingest",
          status: "running",
          pipelineId: profile?.id,
          detailCode: "file_upload",
        });
        recordPipeline({
          utteranceId,
          stage: "lab_finalizer",
          status: "queued",
          pipelineId: profile?.id,
          detailCode: "batch_request",
        });
        addEvent(`${model?.short_name || "高精度モデル"}へ音声ファイルを送信しました`);
        let payload: BatchResponse;
        try {
          payload = await postBatchAudio({
            session,
            assignment,
            audio: file,
            filename: file.name,
            modelId,
            utteranceId,
            signal,
            pipelineId: profile?.id,
          });
        } catch (caught) {
          recordPipeline({
            utteranceId,
            stage: "lab_finalizer",
            status: "failed",
            pipelineId: profile?.id,
            detailCode: "batch_failed",
          });
          throw caught;
        }
        recordPipeline({
          utteranceId,
          stage: "audio_ingest",
          status: "completed",
          pipelineId: profile?.id,
          detailCode: "file_upload",
        });
        const receivedAt = performance.now();
        const batchEvents = batchFinals(payload).map((event) => ({
          ...event,
          authoritative: true,
          finalization_status: "authoritative" as const,
        }));
        if (!batchEvents.length) throw new Error("モデルから文字起こし結果が返りませんでした");
        for (const event of batchEvents) {
          for (const stage of ["audio_ingest", "lab_finalizer", "endpoint"] as const) {
            recordPipeline({
              utteranceId: event.utterance_id,
              stage,
              status: "completed",
              pipelineId: profile?.id,
              audioEndMs: event.audio_end_ms,
              detailCode: stage === "audio_ingest" ? "file_upload" : "batch_response",
            });
          }
        }
        firstTokenRef.current = receivedAt - captureStartedAtRef.current;
        setFirstTokenMs(firstTokenRef.current);
        for (const event of batchEvents) upsertFinal(event);
        setConnection("connected");
        for (const event of batchEvents) await onFinalRef.current?.(event, session.id);
        addEvent(`${model?.short_name || "高精度モデル"}のファイル文字起こしが完了しました`);
        setFinalizing(false);
        return { finals: batchEvents, firstTokenMs: firstTokenRef.current };
      }
      await connect(session, assignment);
      const samples = await decodeAudioFile(file);
      capturingRef.current = true;
      captureStartedAtRef.current = performance.now();
      setCapturing(true);
      setFinalizing(false);
      setSourceLabel(file.name);
      addEvent(`${file.name}の実時間送信を開始しました`);
      const frameSamples = SAMPLE_RATE * 0.1;
      const startedAt = performance.now();
      for (let offset = 0; offset < samples.length && capturingRef.current; offset += frameSamples) {
        if (signal?.aborted) throw new DOMException("ファイル処理を中止しました", "AbortError");
        const target = startedAt + (offset / SAMPLE_RATE) * 1000;
        const delay = target - performance.now();
        if (delay > 1) await wait(delay);
        sendSamples(samples.subarray(offset, Math.min(samples.length, offset + frameSamples)));
      }
      if (terminalFailureRef.current) throw terminalFailureRef.current;
      if (capturingRef.current) await stopInput();
      if (terminalFailureRef.current) throw terminalFailureRef.current;
      return { finals: [...finalsRef.current], firstTokenMs: firstTokenRef.current };
    } catch (caught) {
      const socket = socketRef.current;
      if (socket) expectedCloseSocketsRef.current.add(socket);
      socket?.close();
      socketRef.current = null;
      socketKeyRef.current = null;
      readyRef.current = false;
      inputEndSupportedRef.current = false;
      setConnection("error");
      const failure = caught instanceof Error ? caught : new Error("音声ファイルを処理できません");
      setError(failure.message);
      capturingRef.current = false;
      setCapturing(false);
      setFinalizing(false);
      throw failure;
    }
  }, [addEvent, connect, model, postBatchAudio, recordPipeline, sendSamples, stopInput, upsertFinal]);

  const disconnect = useCallback(async () => {
    capturingRef.current = false;
    hybridGenerationRef.current += 1;
    finalizerAbortRef.current?.abort();
    finalizerAbortRef.current = null;
    finalizationDrainRef.current?.fail(new Error("ストリームの最終確定を中止しました"));
    finalizationDrainRef.current = null;
    await releaseAudio();
    const socket = socketRef.current;
    socketRef.current = null;
    socketKeyRef.current = null;
    readyRef.current = false;
    inputEndSupportedRef.current = false;
    if (socket) expectedCloseSocketsRef.current.add(socket);
    socket?.close();
    setConnection("disconnected");
    setCapturing(false);
    setFinalizing(false);
    setFinalizationBlocked(false);
    activeSessionRef.current = null;
    batchAssignmentRef.current = null;
    timelineRef.current.clear();
    hybridFinalizedRef.current.clear();
    finalizerQueueRef.current = Promise.resolve();
  }, [releaseAudio]);

  const reset = useCallback(() => {
    if (capturingRef.current) return;
    setPartial(null);
    partialRef.current = null;
    setFinals([]);
    finalsRef.current = [];
    terminalFailureRef.current = null;
    setEvents([]);
    dispatchPipeline({ type: "reset" });
    setError("");
    setFinalizationBlocked(false);
    setSourceLabel("未選択");
    setFirstTokenMs(null);
    firstTokenRef.current = null;
    captureStartedAtRef.current = null;
    hybridGenerationRef.current += 1;
    finalizerAbortRef.current?.abort();
    finalizerAbortRef.current = null;
    activeSessionRef.current = null;
    batchAssignmentRef.current = null;
    timelineRef.current.clear();
    hybridFinalizedRef.current.clear();
    finalizerQueueRef.current = Promise.resolve();
  }, []);

  const snapshot = useCallback(() => ({
    finals: [...finalsRef.current],
    firstTokenMs: firstTokenRef.current,
  }), []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  return {
    connection,
    capturing,
    finalizing,
    finalizationBlocked,
    sourceLabel,
    partial,
    finals,
    firstTokenMs,
    error,
    events,
    pipeline,
    recordPipeline,
    connect,
    startMicrophone,
    startFile,
    stopInput,
    disconnect,
    reset,
    snapshot,
  };
}
