import { useCallback, useEffect, useRef, useState } from "react";
import { appendPcmSamples, decodeAudioFile, downsample, floatToPcm, MIN_FRAME_SAMPLES, SAMPLE_RATE, sessionStart } from "./audio";
import { requireAssignmentConnection } from "./assignment";
import { FinalizationDrain } from "./realtimeFinalization";
import type { AsrModel, FinalEvent, InferenceAssignment, PartialEvent, TranscriptionSession } from "./types";

type Connection = "disconnected" | "connecting" | "connected" | "error";

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface BatchResponse {
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
  error?: string;
}

export function batchFinals(payload: BatchResponse): FinalEvent[] {
  const durationMs = Math.max(0, Math.round((payload.duration || 0) * 1000));
  const latencyMs = Number.isFinite(payload.wall) ? Math.round(payload.wall! * 1000) : undefined;
  const rtf = Number.isFinite(payload.rtf)
    ? payload.rtf
    : payload.duration && payload.wall
      ? payload.wall / payload.duration
      : undefined;

  if (payload.utterances?.length) {
    return payload.utterances.map<FinalEvent>((utterance, index) => {
      const startMs = Math.max(0, Math.round(utterance.start_ms || 0));
      const endMs = Math.max(startMs, Math.round(utterance.end_ms || durationMs));
      const speaker = utterance.speaker || `speaker_${index + 1}`;
      return {
        type: "transcript.final",
        utterance_id: utterance.utterance_id || `batch-${index + 1}`,
        revision: 0,
        text: utterance.text.trim(),
        words: [{
          text: utterance.text.trim(),
          start_ms: startMs,
          end_ms: endMs,
          speaker,
          confidence: utterance.confidence,
        }],
        audio_end_ms: endMs,
        latency_ms: latencyMs,
        queue_ms: 0,
        rtf,
      };
    }).filter((event) => event.text);
  }

  const text = (payload.text || "").trim();
  if (!text) return [];
  const marker = /\[spk_(\d+)\]/g;
  const matches = [...text.matchAll(marker)];
  const segments = matches.length
    ? matches.map((match, index) => ({
      speaker: `speaker_${Number(match[1]) + 1}`,
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
        start_ms: startMs,
        end_ms: endMs,
        speaker: segment.speaker,
      }],
      audio_end_ms: endMs,
      latency_ms: latencyMs,
      queue_ms: 0,
      rtf,
    };
  });
}

export function useRealtime(
  model?: AsrModel,
  onFinal?: (event: FinalEvent, sessionId: string) => void | Promise<void>,
  onUnexpectedDisconnect?: (error: Error, sessionId: string) => void | Promise<void>,
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
  const finalizationDrainRef = useRef<FinalizationDrain | null>(null);
  const finalDeliveryTasksRef = useRef(new Set<Promise<void>>());
  const terminalFailureRef = useRef<Error | null>(null);
  const onFinalRef = useRef(onFinal);
  const onUnexpectedDisconnectRef = useRef(onUnexpectedDisconnect);
  onFinalRef.current = onFinal;
  onUnexpectedDisconnectRef.current = onUnexpectedDisconnect;

  const addEvent = useCallback((message: string) => {
    setEvents((current) => [message, ...current].slice(0, 20));
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
    socket.send(floatToPcm(samples));
  }, []);

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
        if (payload.type === "session.ready") {
          window.clearTimeout(timeout);
          settled = true;
          readySeen = true;
          readyRef.current = true;
          inputEndSupportedRef.current = payload.input_end_supported === true;
          setConnection("connected");
          addEvent("実時間ストリームへ接続しました");
          resolve();
        } else if (payload.type === "transcript.partial") {
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          const partialEvent = payload as PartialEvent;
          partialRef.current = partialEvent;
          finalizationDrainRef.current?.notifyPartial(partialEvent.utterance_id);
          setPartial(partialEvent);
        } else if (payload.type === "transcript.final") {
          const finalEvent = payload as FinalEvent;
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          const currentFinals = finalsRef.current;
          const existing = currentFinals.findIndex((item) => item.utterance_id === finalEvent.utterance_id);
          const nextFinals = existing < 0 ? [...currentFinals, finalEvent] : [...currentFinals];
          if (existing >= 0) nextFinals[existing] = finalEvent;
          finalsRef.current = nextFinals;
          setFinals(nextFinals);
          partialRef.current = null;
          setPartial(null);
          finalizationDrainRef.current?.notifyFinal(finalEvent.utterance_id);
          addEvent("発話を確定しました");
          try {
            trackFinalDelivery(onFinalRef.current?.(finalEvent, session.id));
          } catch (caught) {
            trackFinalDelivery(Promise.reject(caught));
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
  }, [addEvent, releaseAudio, trackFinalDelivery]);

  const startMicrophone = useCallback(async (session: TranscriptionSession, assignment: InferenceAssignment) => {
    try {
      if (!model?.input_modes.includes("microphone") || model.runtime !== "realtime") {
        throw new Error("このモデルはマイクのリアルタイム入力に対応していません");
      }
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
  ) => {
    try {
      if (!model?.input_modes.includes("file")) {
        throw new Error("このモデルは音声ファイル入力に対応していません");
      }
      if (model.runtime === "batch") {
        const connectionInfo = requireAssignmentConnection(assignment, "batch");
        setError("");
        setConnection("connecting");
        setCapturing(false);
        setFinalizing(true);
        setSourceLabel(file.name);
        captureStartedAtRef.current = performance.now();
        addEvent(`${model.short_name}へ音声ファイルを送信しました`);
        const form = new FormData();
        form.append("audio", file);
        form.append("model_id", model.id);
        form.append("max_new_tokens", "1500");
        const response = await fetch(connectionInfo.batch_url!, {
          method: "POST",
          headers: { Authorization: `Bearer ${connectionInfo.ticket}` },
          body: form,
          signal,
        });
        const payload = await response.json().catch(() => ({})) as BatchResponse;
        if (!response.ok || payload.error) {
          throw new Error(payload.error || `ファイル文字起こしに失敗しました (HTTP ${response.status})`);
        }
        const receivedAt = performance.now();
        const batchEvents = batchFinals(payload);
        if (!batchEvents.length) throw new Error("モデルから文字起こし結果が返りませんでした");
        firstTokenRef.current = receivedAt - captureStartedAtRef.current;
        setFirstTokenMs(firstTokenRef.current);
        finalsRef.current = batchEvents;
        setFinals(batchEvents);
        setConnection("connected");
        for (const event of batchEvents) await onFinalRef.current?.(event, session.id);
        addEvent(`${model.short_name}のファイル文字起こしが完了しました`);
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
  }, [addEvent, connect, model, sendSamples, stopInput]);

  const disconnect = useCallback(async () => {
    capturingRef.current = false;
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
  }, [releaseAudio]);

  const reset = useCallback(() => {
    if (capturingRef.current) return;
    setPartial(null);
    partialRef.current = null;
    setFinals([]);
    finalsRef.current = [];
    terminalFailureRef.current = null;
    setEvents([]);
    setError("");
    setFinalizationBlocked(false);
    setSourceLabel("未選択");
    setFirstTokenMs(null);
    firstTokenRef.current = null;
    captureStartedAtRef.current = null;
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
    connect,
    startMicrophone,
    startFile,
    stopInput,
    disconnect,
    reset,
    snapshot,
  };
}
