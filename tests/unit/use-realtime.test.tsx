// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrModel, InferenceAssignment, ProcessingProfile, TranscriptionSession } from "../../src/types";
import { useRealtime } from "../../src/useRealtime";

const model: AsrModel = {
  id: "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
  display_name: "Context Full-FT",
  short_name: "Context Full-FT",
  description: "test",
  runtime: "realtime",
  input_modes: ["microphone", "file"],
  supports_context: true,
  supports_diarization: true,
  recommended: true,
  estimated_vram_gb: 20,
  source: "private_model",
  integration_status: "ready",
  selectable: true,
};

const session: TranscriptionSession = {
  id: "session-1",
  title: "test",
  title_customized: false,
  status: "recording",
  source: "microphone",
  processing_mode: "realtime",
  model_id: model.id,
  final_model_id: null,
  catalog_revision: "r1",
  started_at: new Date(0).toISOString(),
  ended_at: null,
  last_activity_at: new Date(0).toISOString(),
  duration_ms: null,
  metrics: {},
  expires_at: new Date(1).toISOString(),
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  utterance_count: 0,
};

const assignment: InferenceAssignment = {
  id: "assignment-1",
  session_id: session.id,
  model_id: model.id,
  purpose: "realtime",
  status: "ready",
  connection: {
    websocket_url: "wss://worker.example/v1/realtime",
    ticket: "ticket",
    expires_at: new Date(60_000).toISOString(),
    catalog_revision: "r1",
  },
};

const hybridProfile: ProcessingProfile = {
  id: "hybrid",
  display_name: "ライブ＋高精度確定",
  description: "test",
  input_modes: ["microphone", "file"],
  primary_model_id: model.id,
  final_model_id: "final-model",
  assignments: [
    { purpose: "realtime", model_id: model.id },
    { purpose: "batch", model_id: "final-model" },
  ],
  nodes: [
    { id: "context_asr", label: "Context" },
    { id: "replace_result", label: "置換" },
  ],
  edges: [{ from: "context_asr", to: "replace_result" }],
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new DOMException("socket is not open");
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(payload: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }

  closeFromPeer() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

type Realtime = ReturnType<typeof useRealtime>;

async function connectReady(realtime: Realtime, inputEndSupported = true) {
  let connection!: Promise<void>;
  await act(async () => {
    connection = realtime.connect(session, assignment);
    await Promise.resolve();
  });
  const socket = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive({
      type: "session.ready",
      session_id: session.id,
      catalog_revision: "r1",
      worker_id: "worker-1",
      model_id: model.id,
      input_end_supported: inputEndSupported,
    });
    await connection;
  });
  return socket;
}

describe("useRealtime terminal ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let realtime: Realtime;
  let originalWebSocket: typeof WebSocket;

  beforeEach(async () => {
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.instances = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.WebSocket = originalWebSocket;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("waits for stream.finalized and the tail final save before stop resolves", async () => {
    let releaseSave!: () => void;
    const save = new Promise<void>((resolve) => { releaseSave = resolve; });
    const onFinal = vi.fn(() => save);
    const onUnexpectedDisconnect = vi.fn();

    function Harness() {
      realtime = useRealtime(model, onFinal, onUnexpectedDisconnect);
      return null;
    }
    await act(async () => root.render(<Harness />));
    const socket = await connectReady(realtime);
    socket.receive({
      type: "transcript.partial",
      utterance_id: "tail",
      revision: 1,
      stable_text: "あかつき",
      unstable_text: "証券",
      audio_end_ms: 1_000,
    });

    let stop!: Promise<void>;
    let stopped = false;
    await act(async () => {
      stop = realtime.stopInput();
      void stop.then(() => { stopped = true; });
      await Promise.resolve();
    });
    expect(socket.sent.some((value) => value === JSON.stringify({ type: "input.end" }))).toBe(true);

    await act(async () => {
      socket.receive({
        type: "transcript.final",
        utterance_id: "tail",
        text: "あかつき証券",
        words: [],
        context_hits: [],
      });
      socket.receive({ type: "stream.finalized", session_id: session.id });
      await Promise.resolve();
    });
    expect(stopped).toBe(false);

    await act(async () => {
      releaseSave();
      await stop;
    });
    expect(stopped).toBe(true);
    expect(onFinal).toHaveBeenCalledTimes(1);

    socket.closeFromPeer();
    expect(onUnexpectedDisconnect).not.toHaveBeenCalled();
  });

  it("reports an established socket error and close only once", async () => {
    const onUnexpectedDisconnect = vi.fn();
    function Harness() {
      realtime = useRealtime(model, undefined, onUnexpectedDisconnect);
      return null;
    }
    await act(async () => root.render(<Harness />));
    const socket = await connectReady(realtime);

    await act(async () => {
      socket.fail();
      socket.closeFromPeer();
      await Promise.resolve();
    });
    expect(onUnexpectedDisconnect).toHaveBeenCalledTimes(1);
    expect(onUnexpectedDisconnect.mock.calls[0][1]).toBe(session.id);
  });

  it("does not report an intentional disconnect", async () => {
    const onUnexpectedDisconnect = vi.fn();
    function Harness() {
      realtime = useRealtime(model, undefined, onUnexpectedDisconnect);
      return null;
    }
    await act(async () => root.render(<Harness />));
    await connectReady(realtime);

    await act(async () => realtime.disconnect());
    expect(onUnexpectedDisconnect).not.toHaveBeenCalled();
  });

  it("does not erase a newer partial when an older utterance final arrives", async () => {
    function Harness() {
      realtime = useRealtime(model);
      return null;
    }
    await act(async () => root.render(<Harness />));
    const socket = await connectReady(realtime);

    await act(async () => {
      socket.receive({
        type: "transcript.partial",
        utterance_id: "utterance-a",
        revision: 1,
        stable_text: "古い",
        unstable_text: "発話",
        audio_end_ms: 1_000,
      });
      socket.receive({
        type: "transcript.partial",
        utterance_id: "utterance-b",
        revision: 1,
        stable_text: "新しい",
        unstable_text: "発話",
        audio_end_ms: 1_500,
      });
      socket.receive({
        type: "transcript.final",
        utterance_id: "utterance-a",
        revision: 2,
        text: "古い発話",
        words: [],
        audio_end_ms: 1_000,
      });
      await Promise.resolve();
    });

    expect(realtime.partial?.utterance_id).toBe("utterance-b");
    expect(realtime.finals.map((item) => item.utterance_id)).toEqual(["utterance-a"]);
  });

  it("ignores worker replace_result events in hybrid mode", async () => {
    function Harness() {
      realtime = useRealtime(model, undefined, undefined, hybridProfile);
      return null;
    }
    await act(async () => root.render(<Harness />));
    const socket = await connectReady(realtime);

    await act(async () => {
      socket.receive({
        type: "pipeline.stage",
        seq: 1,
        pipeline_id: "worker-pipeline",
        utterance_id: "utterance-1",
        stage: "replace_result",
        status: "completed",
        audio_end_ms: 1_000,
        elapsed_ms: 1,
        detail_code: "context_final",
      });
      socket.receive({
        type: "pipeline.stage",
        seq: 2,
        pipeline_id: "worker-pipeline",
        utterance_id: "utterance-1",
        stage: "context_asr",
        status: "completed",
        audio_end_ms: 1_000,
        elapsed_ms: 10,
        detail_code: null,
      });
      await Promise.resolve();
    });

    expect(realtime.pipeline.log).toHaveLength(1);
    expect(realtime.pipeline.log[0]?.stage).toBe("context_asr");
  });
});
