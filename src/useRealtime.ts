import { useCallback, useEffect, useRef, useState } from "react";
import { appendPcmSamples, decodeAudioFile, downsample, floatToPcm, MIN_FRAME_SAMPLES, SAMPLE_RATE, sessionStart } from "./audio";
import type { AsrModel, ControlStatus, FinalEvent, PartialEvent } from "./types";

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
  status?: ControlStatus,
  model?: AsrModel,
  onFinal?: (event: FinalEvent) => void | Promise<void>,
) {
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [capturing, setCapturing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("未選択");
  const [partial, setPartial] = useState<PartialEvent | null>(null);
  const [finals, setFinals] = useState<FinalEvent[]>([]);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const capturingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const microphoneBufferRef = useRef(new Float32Array());
  const captureStartedAtRef = useRef<number | null>(null);
  const firstTokenRef = useRef<number | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const addEvent = useCallback((message: string) => {
    setEvents((current) => [message, ...current].slice(0, 20));
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

  const connect = useCallback(async (sessionId: string) => {
    if (!status || status.stage !== "ready") throw new Error("GPUサービスがまだ準備できていません");
    if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN) return;
    socketRef.current?.close();
    setConnection("connecting");
    setError("");
    const socket = new WebSocket(status.service.websocketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("WebSocketの準備がタイムアウトしました"));
      }, 20_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(sessionStart(
          sessionId,
          status.service.health?.catalog_revision || "",
          model?.id || status.service.health?.model || "",
        )));
      });
      socket.addEventListener("message", (event) => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.type === "session.ready") {
          window.clearTimeout(timeout);
          readyRef.current = true;
          setConnection("connected");
          addEvent("実時間ストリームへ接続しました");
          resolve();
        } else if (payload.type === "transcript.partial") {
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          setPartial(payload as PartialEvent);
        } else if (payload.type === "transcript.final") {
          const finalEvent = payload as FinalEvent;
          if (firstTokenRef.current === null && captureStartedAtRef.current !== null) {
            firstTokenRef.current = performance.now() - captureStartedAtRef.current;
            setFirstTokenMs(firstTokenRef.current);
          }
          setFinals((current) => {
            const existing = current.findIndex((item) => item.utterance_id === finalEvent.utterance_id);
            if (existing < 0) return [...current, finalEvent];
            const next = [...current];
            next[existing] = finalEvent;
            return next;
          });
          setPartial(null);
          addEvent("発話を確定しました");
          void onFinalRef.current?.(finalEvent);
        } else if (payload.type === "error") {
          setError(`${payload.code}: ${payload.message}`);
        }
      });
      socket.addEventListener("error", () => {
        setConnection("error");
        setError("WebSocket接続でエラーが発生しました");
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(timeout);
        readyRef.current = false;
        setConnection("disconnected");
        setCapturing(false);
        capturingRef.current = false;
      });
    });
  }, [addEvent, model?.id, status]);

  const startMicrophone = useCallback(async (sessionId: string) => {
    try {
      if (!model?.input_modes.includes("microphone") || model.runtime !== "realtime") {
        throw new Error("このモデルはマイクのリアルタイム入力に対応していません");
      }
      await connect(sessionId);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
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
      setError(caught instanceof Error ? caught.message : "マイクを開始できません");
    }
  }, [addEvent, connect, model, releaseAudio, sendSamples]);

  const stopInput = useCallback(async () => {
    capturingRef.current = false;
    setFinalizing(true);
    if (readyRef.current && microphoneBufferRef.current.length) {
      const paddedTail = new Float32Array(MIN_FRAME_SAMPLES);
      paddedTail.set(microphoneBufferRef.current);
      microphoneBufferRef.current = new Float32Array();
      sendSamples(paddedTail);
    }
    await releaseAudio();
    if (readyRef.current) {
      const silence = new Float32Array(SAMPLE_RATE * 0.1);
      for (let index = 0; index < 7; index += 1) {
        sendSamples(silence);
        await wait(100);
      }
    }
    setCapturing(false);
    addEvent("音声入力を停止し、発話終端を送りました");
    await wait(450);
    setFinalizing(false);
  }, [addEvent, releaseAudio, sendSamples]);

  const startFile = useCallback(async (sessionId: string, file: File) => {
    try {
      if (!model?.input_modes.includes("file")) {
        throw new Error("このモデルは音声ファイル入力に対応していません");
      }
      if (model.runtime === "batch") {
        if (!status || status.stage !== "ready") throw new Error("GPUサービスがまだ準備できていません");
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
        const response = await fetch(status.service.batchUrl, { method: "POST", body: form });
        const payload = await response.json().catch(() => ({})) as BatchResponse;
        if (!response.ok || payload.error) {
          throw new Error(payload.error || `ファイル文字起こしに失敗しました (HTTP ${response.status})`);
        }
        const receivedAt = performance.now();
        const batchEvents = batchFinals(payload);
        if (!batchEvents.length) throw new Error("モデルから文字起こし結果が返りませんでした");
        firstTokenRef.current = receivedAt - captureStartedAtRef.current;
        setFirstTokenMs(firstTokenRef.current);
        setFinals(batchEvents);
        setConnection("connected");
        for (const event of batchEvents) await onFinalRef.current?.(event);
        addEvent(`${model.short_name}のファイル文字起こしが完了しました`);
        setFinalizing(false);
        return;
      }
      await connect(sessionId);
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
        const target = startedAt + (offset / SAMPLE_RATE) * 1000;
        const delay = target - performance.now();
        if (delay > 1) await wait(delay);
        sendSamples(samples.subarray(offset, Math.min(samples.length, offset + frameSamples)));
      }
      if (capturingRef.current) await stopInput();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "音声ファイルを処理できません");
      capturingRef.current = false;
      setCapturing(false);
      setFinalizing(false);
    }
  }, [addEvent, connect, model, sendSamples, status, stopInput]);

  const disconnect = useCallback(async () => {
    capturingRef.current = false;
    await releaseAudio();
    socketRef.current?.close();
    socketRef.current = null;
    readyRef.current = false;
    setFinalizing(false);
  }, [releaseAudio]);

  const reset = useCallback(() => {
    if (capturingRef.current) return;
    setPartial(null);
    setFinals([]);
    setEvents([]);
    setError("");
    setSourceLabel("未選択");
    setFirstTokenMs(null);
    firstTokenRef.current = null;
    captureStartedAtRef.current = null;
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  return {
    connection,
    capturing,
    finalizing,
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
  };
}
