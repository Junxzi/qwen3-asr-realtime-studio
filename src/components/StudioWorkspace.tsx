import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/api";
import {
  assignmentIsReady,
  assignmentMessage,
  assignmentPollDelay,
  assertAssignmentMatches,
  requireAssignmentConnection,
  waitForAssignmentPoll,
} from "@/assignment";
import { AppShell } from "@/components/AppShell";
import { AudioComposer } from "@/components/AudioComposer";
import { Conversation, type ConversationItem } from "@/components/Conversation";
import { DiagnosticsDrawer } from "@/components/DiagnosticsDrawer";
import { ModelPicker } from "@/components/ModelPicker";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { percentile } from "@/lib/format";
import {
  enqueueOutbox,
  flushOutbox,
  listOutbox,
  outboxKey,
  removeOutbox,
  removeSessionOutbox,
} from "@/outbox";
import type {
  ControlStatus,
  FinalEvent,
  InferenceAssignment,
  PersistUtteranceInput,
  TranscriptSource,
  TranscriptionMetrics,
  TranscriptionSession,
} from "@/types";
import { retryTerminalCompletion, SessionTerminalizationLatch } from "@/terminalization";
import { useAssignmentHeartbeat } from "@/useAssignmentHeartbeat";
import { useRealtime } from "@/useRealtime";

const MODEL_ID = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";

function finalPayload(event: FinalEvent): PersistUtteranceInput {
  return {
    revision: event.revision || 0,
    text: event.text,
    words: event.words || [],
    context_hits: event.context_hits || [],
    audio_end_ms: event.audio_end_ms || event.words?.at(-1)?.end_ms || 0,
    latency_ms: event.latency_ms ?? null,
    queue_ms: event.queue_ms ?? null,
    rtf: event.rtf ?? null,
  };
}

function liveMetrics(finals: FinalEvent[], firstTokenMs: number | null): TranscriptionMetrics {
  const rtfValues = finals.map((item) => item.rtf).filter((value): value is number => Number.isFinite(value));
  return {
    ttft_ms: firstTokenMs,
    stable_latency_p95_ms: percentile(finals.map((item) => item.latency_ms)),
    queue_p95_ms: percentile(finals.map((item) => item.queue_ms)),
    rewrite_rate: null,
    rtf: rtfValues.length ? rtfValues.reduce((sum, value) => sum + value, 0) / rtfValues.length : null,
    context_hits: finals.reduce((count, item) => count + (item.context_hits?.length || 0), 0),
  };
}

function liveConversationItems(finals: FinalEvent[], startedAt?: string): ConversationItem[] {
  return finals.map((item, index) => ({
    id: item.utterance_id,
    speaker: item.words?.[0]?.speaker || (index % 2 ? "speaker_2" : "speaker_1"),
    text: item.text,
    words: item.words || [],
    audioEndMs: item.audio_end_ms || item.words?.at(-1)?.end_ms || 0,
    createdAt: startedAt || new Date().toISOString(),
    contextHits: item.context_hits || [],
    latencyMs: item.latency_ms ?? null,
  }));
}

interface StudioWorkspaceProps {
  status?: ControlStatus;
  statusError?: string;
  onRefreshStatus: () => void;
  onLogout: () => void;
}

function startErrorMessage(error: unknown) {
  if (error instanceof ApiError && (error.code === "capacity_exceeded" || error.status === 429)) {
    return "現在、利用できるGPU容量がありません。しばらく待ってから再試行してください。";
  }
  return error instanceof Error ? error.message : "GPUを割り当てできません";
}

export function StudioWorkspace({ status, statusError, onRefreshStatus, onLogout }: StudioWorkspaceProps) {
  const { id: historyId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<TranscriptionSession | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [terminalCompletionPending, setTerminalCompletionPending] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [pendingSaves, setPendingSaves] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState(MODEL_ID);
  const [assignment, setAssignment] = useState<InferenceAssignment | null>(null);
  const [clock, setClock] = useState(Date.now());
  const activeSessionRef = useRef<TranscriptionSession | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const inFlightSavesRef = useRef(new Set<Promise<void>>());
  const assignmentAbortRef = useRef<AbortController | null>(null);
  const operationLockRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const terminalizationRef = useRef(new SessionTerminalizationLatch());
  const terminalStatusRef = useRef<"completed" | "interrupted" | "failed" | null>(null);
  const unexpectedDisconnectHandlerRef = useRef<(error: Error, sessionId: string) => void>(() => undefined);

  const history = useQuery({
    queryKey: ["transcriptions", deferredSearch],
    queryFn: () => api.transcriptions({ q: deferredSearch || undefined, limit: 50 }),
    staleTime: 5_000,
  });
  const detail = useQuery({
    queryKey: ["transcription", historyId],
    queryFn: () => api.transcription(historyId!),
    enabled: Boolean(historyId),
    retry: 1,
  });
  const modelCatalog = useQuery({
    queryKey: ["asr-models"],
    queryFn: api.models,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const models = modelCatalog.data?.items || [];
  const sessionModelId = historyId
    ? (detail.data?.model_id || selectedModelId)
    : (activeSession?.model_id || selectedModelId);
  const selectedModel = models.find((model) => model.id === sessionModelId);

  useEffect(() => {
    const catalog = modelCatalog.data;
    if (!catalog || catalog.items.some((model) => model.id === selectedModelId)) return;
    setSelectedModelId(catalog.default_model_id);
  }, [modelCatalog.data, selectedModelId]);

  const refreshPending = useCallback(async () => {
    setPendingSaves((await listOutbox()).length);
  }, []);

  const persistFinal = useCallback((event: FinalEvent, sessionId: string) => {
    const task = (async () => {
      const payload = finalPayload(event);
      try {
        await api.saveUtterance(sessionId, event.utterance_id, payload);
        await removeOutbox(outboxKey(sessionId, event.utterance_id));
      } catch {
        await enqueueOutbox(sessionId, event.utterance_id, payload);
      } finally {
        await refreshPending();
        await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
      }
    })();
    inFlightSavesRef.current.add(task);
    void task.finally(() => inFlightSavesRef.current.delete(task));
    return task;
  }, [queryClient, refreshPending]);

  const realtime = useRealtime(
    selectedModel,
    persistFinal,
    (error, sessionId) => unexpectedDisconnectHandlerRef.current(error, sessionId),
  );
  const {
    start: startAssignmentHeartbeat,
    stop: stopAssignmentHeartbeat,
  } = useAssignmentHeartbeat(
    (error, sessionId) => unexpectedDisconnectHandlerRef.current(error, sessionId),
  );
  const metrics = useMemo(
    () => historyId ? (detail.data?.metrics || {}) : liveMetrics(realtime.finals, realtime.firstTokenMs),
    [detail.data?.metrics, historyId, realtime.finals, realtime.firstTokenMs],
  );

  const flushPending = useCallback(async () => {
    const result = await flushOutbox((item) => api.saveUtterance(item.sessionId, item.utteranceId, item.payload));
    setPendingSaves(result.pending);
    if (result.saved) {
      await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
      if (historyId) await queryClient.invalidateQueries({ queryKey: ["transcription", historyId] });
    }
  }, [historyId, queryClient]);

  useEffect(() => {
    void refreshPending().then(flushPending);
    const interval = window.setInterval(() => { void flushPending(); }, 5_000);
    const online = () => { void flushPending(); };
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", online);
    };
  }, [flushPending, refreshPending]);

  useEffect(() => {
    if (!realtime.capturing && !realtime.finalizing) return;
    const interval = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [realtime.capturing, realtime.finalizing]);

  useEffect(() => {
    const interrupt = () => {
      const session = activeSessionRef.current;
      if (!session) return;
      stopAssignmentHeartbeat(session.id);
      const terminalStatus = terminalStatusRef.current ?? "interrupted";
      terminalStatusRef.current = terminalStatus;
      void terminalizationRef.current.run(session.id, async () => {
        const response = await fetch(`/api/transcriptions/${encodeURIComponent(session.id)}/complete`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: terminalStatus,
            duration_ms: startedAtRef.current ? Date.now() - startedAtRef.current : null,
            metrics: liveMetrics(realtime.finals, realtime.firstTokenMs),
          }),
          keepalive: true,
        });
        if (!response.ok) throw new Error("終了時のセッション解放に失敗しました");
      }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", interrupt);
    return () => window.removeEventListener("beforeunload", interrupt);
  }, [realtime.finals, realtime.firstTokenMs, stopAssignmentHeartbeat]);

  useEffect(() => () => assignmentAbortRef.current?.abort(), []);

  const createSession = async (source: TranscriptSource) => {
    if (!selectedModel) throw new Error("文字起こしモデルを読み込んでいます");
    realtime.reset();
    setAssignment(null);
    setWorkspaceError("");
    setTerminalCompletionPending(false);
    const session = await api.createTranscription({
      source,
      model_id: selectedModel.id,
      catalog_revision: "",
    });
    setActiveSession(session);
    activeSessionRef.current = session;
    terminalizationRef.current.reset();
    terminalStatusRef.current = null;
    startedAtRef.current = Date.now();
    setClock(Date.now());
    await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
    return session;
  };

  const assignWorker = async (session: TranscriptionSession, controller: AbortController) => {
    if (!selectedModel) throw new Error("文字起こしモデルを読み込んでいます");
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = controller;
    const purpose = selectedModel.runtime;
    let current = await api.requestAssignment(session.id, purpose, controller.signal);
    assertAssignmentMatches(current, session);
    setAssignment(current);
    while (!assignmentIsReady(current)) {
      if (current.status === "failed") throw new Error(assignmentMessage(current, selectedModel.display_name));
      if (current.status === "released") throw new Error("GPUの割り当てが処理開始前に解放されました");
      await waitForAssignmentPoll(assignmentPollDelay(current), controller.signal);
      current = await api.requestAssignment(session.id, purpose, controller.signal);
      assertAssignmentMatches(current, session);
      setAssignment(current);
    }
    requireAssignmentConnection(current, purpose);
    return current;
  };

  const completeActive = (
    completionStatus: "completed" | "interrupted" | "failed" = "completed",
    expectedSessionId?: string,
  ): Promise<void> => {
    const session = activeSessionRef.current;
    if (!session || (expectedSessionId && session.id !== expectedSessionId)) return Promise.resolve();
    stopAssignmentHeartbeat(session.id);
    const terminalStatus = terminalStatusRef.current ?? completionStatus;
    terminalStatusRef.current = terminalStatus;
    return terminalizationRef.current.run(session.id, async () => {
      const duration = startedAtRef.current ? Date.now() - startedAtRef.current : null;
      const snapshot = realtime.snapshot();
      let completed = false;
      try {
        await Promise.allSettled([...inFlightSavesRef.current]);
        await flushPending();
        await retryTerminalCompletion(() => api.completeTranscription(session.id, {
          status: terminalStatus,
          duration_ms: duration,
          metrics: liveMetrics(snapshot.finals, snapshot.firstTokenMs),
        }).then(() => undefined));
        completed = true;
        setTerminalCompletionPending(false);
      } catch (error) {
        setTerminalCompletionPending(true);
        throw error;
      } finally {
        assignmentAbortRef.current?.abort();
        assignmentAbortRef.current = null;
        await realtime.disconnect().catch(() => undefined);
        if (completed && activeSessionRef.current?.id === session.id) {
          activeSessionRef.current = null;
          setActiveSession(null);
          setAssignment(null);
          startedAtRef.current = null;
          terminalStatusRef.current = null;
        }
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ["transcriptions"] }),
          queryClient.invalidateQueries({ queryKey: ["transcription", session.id] }),
        ]);
      }
      navigate(`/transcriptions/${session.id}`);
    });
  };

  unexpectedDisconnectHandlerRef.current = (failure, sessionId) => {
    if (activeSessionRef.current?.id !== sessionId) return;
    const operationGeneration = ++operationGenerationRef.current;
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = null;
    operationLockRef.current = true;
    setOperationBusy(true);
    setWorkspaceError(failure.message);
    toast.error(failure.message);
    void completeActive("failed", sessionId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : "切断後のセッション解放に失敗しました";
        setWorkspaceError(message);
        toast.error(message);
      })
      .finally(() => {
        if (operationGeneration === operationGenerationRef.current) {
          operationLockRef.current = false;
          setOperationBusy(false);
        }
      });
  };

  const startMicrophone = async () => {
    if (operationLockRef.current || !selectedModel?.input_modes.includes("microphone")) return;
    operationLockRef.current = true;
    const operationGeneration = ++operationGenerationRef.current;
    const controller = new AbortController();
    setOperationBusy(true);
    try {
      const session = await createSession("microphone");
      const assigned = await assignWorker(session, controller);
      if (operationGeneration !== operationGenerationRef.current) return;
      startAssignmentHeartbeat(session.id);
      await realtime.startMicrophone(session, assigned);
      if (operationGeneration !== operationGenerationRef.current) {
        await realtime.disconnect();
        return;
      }
      toast.success("マイクの文字起こしを開始しました");
    } catch (error) {
      if (operationGeneration !== operationGenerationRef.current) return;
      const message = startErrorMessage(error);
      setWorkspaceError(message);
      if (activeSessionRef.current) await completeActive("failed").catch(() => undefined);
      toast.error(message);
    } finally {
      if (operationGeneration === operationGenerationRef.current) {
        operationLockRef.current = false;
        assignmentAbortRef.current = null;
        setOperationBusy(false);
      }
    }
  };

  const startFile = async (file: File) => {
    if (operationLockRef.current || !selectedModel?.input_modes.includes("file")) return;
    operationLockRef.current = true;
    const operationGeneration = ++operationGenerationRef.current;
    const controller = new AbortController();
    setOperationBusy(true);
    try {
      const session = await createSession("file");
      const assigned = await assignWorker(session, controller);
      if (operationGeneration !== operationGenerationRef.current) return;
      startAssignmentHeartbeat(session.id);
      await realtime.startFile(session, file, assigned, controller.signal);
      if (operationGeneration !== operationGenerationRef.current) return;
      await completeActive("completed");
      toast.success("音声ファイルの文字起こしを完了しました");
    } catch (error) {
      if (operationGeneration !== operationGenerationRef.current) return;
      const message = startErrorMessage(error);
      setWorkspaceError(message);
      if (activeSessionRef.current) await completeActive("failed").catch(() => undefined);
      toast.error(message);
    } finally {
      if (operationGeneration === operationGenerationRef.current) {
        operationLockRef.current = false;
        assignmentAbortRef.current = null;
        setOperationBusy(false);
      }
    }
  };

  const cancelOperation = async () => {
    if (!operationLockRef.current && !realtime.finalizationBlocked) return;
    ++operationGenerationRef.current;
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = null;
    try {
      if (activeSessionRef.current) await completeActive("interrupted");
      else await realtime.disconnect();
      toast.message("処理を中止しました");
    } catch (error) {
      const message = error instanceof Error ? error.message : "処理を中止できませんでした";
      setWorkspaceError(message);
      toast.error(message);
    } finally {
      operationLockRef.current = false;
      setOperationBusy(false);
    }
  };

  const stopMicrophone = async () => {
    if (!activeSessionRef.current || operationLockRef.current) return;
    operationLockRef.current = true;
    setOperationBusy(true);
    try {
      await realtime.stopInput();
      await completeActive("completed");
      toast.success("文字起こしを保存しました");
    } catch (error) {
      const message = error instanceof Error ? error.message : "文字起こしを終了できません";
      setWorkspaceError(message);
      toast.error(message);
    } finally {
      operationLockRef.current = false;
      setOperationBusy(false);
    }
  };

  const retryActiveCompletion = async () => {
    if (!activeSessionRef.current || operationLockRef.current || !terminalCompletionPending) return;
    operationLockRef.current = true;
    setOperationBusy(true);
    setWorkspaceError("");
    try {
      await completeActive();
      toast.success("保存とGPU解放を完了しました");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存とGPU解放を再試行できませんでした";
      setWorkspaceError(message);
      toast.error(message);
    } finally {
      operationLockRef.current = false;
      setOperationBusy(false);
    }
  };

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameTranscription(id, title),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
      queryClient.setQueryData(["transcription", session.id], (current: unknown) => (
        current && typeof current === "object" ? { ...current, title: session.title, title_customized: true } : current
      ));
      toast.success("名称を変更しました");
    },
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteTranscription,
    onSuccess: async (_result, deletedId) => {
      await removeSessionOutbox(deletedId);
      await refreshPending();
      await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
      queryClient.removeQueries({ queryKey: ["transcription", deletedId] });
      if (historyId === deletedId) navigate("/");
      toast.success("文字起こし履歴を削除しました");
    },
  });

  const historyItems = history.data?.items || [];
  const selectedId = historyId || activeSession?.id;
  const title = detail.data?.title
    || historyItems.find((item) => item.id === activeSession?.id)?.title
    || activeSession?.title
    || "新しい文字起こし";
  const elapsedMs = historyId
    ? (detail.data?.duration_ms || 0)
    : startedAtRef.current
      ? Math.max(0, clock - startedAtRef.current)
      : 0;
  const conversationItems: ConversationItem[] = historyId
    ? (detail.data?.utterances || []).map((utterance) => ({
      id: utterance.id,
      speaker: utterance.speaker,
      text: utterance.text,
      words: utterance.words,
      audioEndMs: utterance.audio_end_ms,
      createdAt: utterance.created_at,
      contextHits: utterance.context_hits,
      latencyMs: utterance.latency_ms,
    }))
    : liveConversationItems(realtime.finals, activeSession?.started_at);
  const busy = operationBusy || realtime.capturing || realtime.finalizing || realtime.finalizationBlocked;

  const sidebar = (
    <Sidebar
      sessions={historyItems}
      selectedId={selectedId}
      search={search}
      busy={busy}
      loading={history.isPending}
      error={history.error?.message}
      onSearch={setSearch}
      onNew={() => {
        if (!busy) {
          realtime.reset();
          setAssignment(null);
          setWorkspaceError("");
          navigate("/");
        }
      }}
      onSelect={(id) => { if (!busy) navigate(`/transcriptions/${id}`); }}
      onRename={(id, nextTitle) => renameMutation.mutateAsync({ id, title: nextTitle }).then(() => undefined)}
      onDelete={(id) => deleteMutation.mutateAsync(id).then(() => undefined)}
      onRetry={() => void history.refetch()}
      onLogout={onLogout}
    />
  );

  return (
    <AppShell
      title={title}
      status={status}
      statusError={statusError}
      sidebar={sidebar}
      modelControl={(
        <ModelPicker
          models={models}
          value={sessionModelId}
          disabled={busy || modelCatalog.isPending}
          readOnly={Boolean(historyId)}
          onChange={(modelId) => {
            const next = models.find((model) => model.id === modelId);
            setSelectedModelId(modelId);
            if (next) toast.message(`${next.display_name}を選択しました`);
          }}
        />
      )}
      diagnosticsOpen={diagnosticsOpen}
      onDiagnostics={() => setDiagnosticsOpen((open) => !open)}
    >
      <main className="workspace-main">
        <Conversation
          items={conversationItems}
          partial={historyId ? null : realtime.partial}
          startedAt={detail.data?.started_at || activeSession?.started_at}
          stage={status?.stage}
          live={!historyId}
          loading={Boolean(historyId && detail.isPending)}
          error={workspaceError || realtime.error || detail.error?.message}
          model={selectedModel}
        />
        {historyId ? (
          <div className="history-readonly-bar">
            <div>
              <strong>保存済みの文字起こし</strong>
              <span>音声は保存されていません · {detail.data?.utterance_count || 0}発話</span>
            </div>
            <Button variant="subtle" onClick={() => navigate("/")}>
              <Plus data-icon="inline-start" />新しい文字起こし
            </Button>
          </div>
        ) : (
          <AudioComposer
            assignment={assignment}
            connection={realtime.connection}
            capturing={realtime.capturing}
            finalizing={realtime.finalizing}
            completionRetryRequired={terminalCompletionPending}
            busy={operationBusy || realtime.finalizationBlocked}
            cancellable={realtime.finalizationBlocked || (operationBusy && (!realtime.capturing || activeSession?.source === "file"))}
            elapsedMs={elapsedMs}
            pendingSaves={pendingSaves}
            sourceLabel={realtime.sourceLabel}
            model={selectedModel}
            onMicrophone={() => void startMicrophone()}
            onFile={(file) => void startFile(file)}
            onStop={() => void stopMicrophone()}
            onRetryCompletion={() => void retryActiveCompletion()}
            onCancel={() => void cancelOperation()}
          />
        )}
      </main>
      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        status={status}
        statusError={statusError}
        assignment={historyId ? null : assignment}
        connection={historyId ? "disconnected" : realtime.connection}
        elapsedMs={elapsedMs}
        metrics={metrics}
        events={historyId ? [] : realtime.events}
        pendingSaves={pendingSaves}
        model={selectedModel}
        onRefresh={onRefreshStatus}
      />
    </AppShell>
  );
}
