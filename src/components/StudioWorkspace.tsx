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
import { api } from "@/api";
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
  PersistUtteranceInput,
  TranscriptSource,
  TranscriptionMetrics,
  TranscriptionSession,
} from "@/types";
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
  status: ControlStatus;
  onRefreshStatus: () => void;
  onLogout: () => void;
}

export function StudioWorkspace({ status, onRefreshStatus, onLogout }: StudioWorkspaceProps) {
  const { id: historyId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<TranscriptionSession | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [pendingSaves, setPendingSaves] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState(MODEL_ID);
  const [clock, setClock] = useState(Date.now());
  const activeSessionRef = useRef<TranscriptionSession | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const inFlightSavesRef = useRef(new Set<Promise<void>>());

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

  const persistFinal = useCallback((event: FinalEvent) => {
    const sessionId = activeSessionRef.current?.id;
    if (!sessionId) return undefined;
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

  const realtime = useRealtime(status, selectedModel, persistFinal);
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
      void fetch(`/api/transcriptions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "interrupted",
          duration_ms: startedAtRef.current ? Date.now() - startedAtRef.current : null,
          metrics: liveMetrics(realtime.finals, realtime.firstTokenMs),
        }),
        keepalive: true,
      });
    };
    window.addEventListener("beforeunload", interrupt);
    return () => window.removeEventListener("beforeunload", interrupt);
  }, [realtime.finals, realtime.firstTokenMs]);

  const createSession = async (source: TranscriptSource) => {
    if (!selectedModel) throw new Error("文字起こしモデルを読み込んでいます");
    realtime.reset();
    setWorkspaceError("");
    const session = await api.createTranscription({
      source,
      model_id: selectedModel.id,
      catalog_revision: selectedModel.supports_context ? (status.service.health?.catalog_revision || "") : "",
    });
    setActiveSession(session);
    activeSessionRef.current = session;
    startedAtRef.current = Date.now();
    setClock(Date.now());
    await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
    return session;
  };

  const completeActive = async (completionStatus: "completed" | "failed" = "completed") => {
    const session = activeSessionRef.current;
    if (!session) return;
    const duration = startedAtRef.current ? Date.now() - startedAtRef.current : null;
    await Promise.allSettled([...inFlightSavesRef.current]);
    await flushPending();
    await api.completeTranscription(session.id, {
      status: completionStatus,
      duration_ms: duration,
      metrics: liveMetrics(realtime.finals, realtime.firstTokenMs),
    });
    await realtime.disconnect();
    activeSessionRef.current = null;
    setActiveSession(null);
    startedAtRef.current = null;
    await queryClient.invalidateQueries({ queryKey: ["transcriptions"] });
    await queryClient.invalidateQueries({ queryKey: ["transcription", session.id] });
    navigate(`/transcriptions/${session.id}`);
  };

  const startMicrophone = async () => {
    if (status.stage !== "ready" || operationBusy || !selectedModel?.input_modes.includes("microphone")) return;
    setOperationBusy(true);
    try {
      const session = await createSession("microphone");
      await realtime.startMicrophone(session.id);
      toast.success("マイクの文字起こしを開始しました");
    } catch (error) {
      const message = error instanceof Error ? error.message : "マイクを開始できません";
      setWorkspaceError(message);
      if (activeSessionRef.current) await completeActive("failed").catch(() => undefined);
      toast.error(message);
    } finally {
      setOperationBusy(false);
    }
  };

  const startFile = async (file: File) => {
    if (status.stage !== "ready" || operationBusy || !selectedModel?.input_modes.includes("file")) return;
    setOperationBusy(true);
    try {
      const session = await createSession("file");
      await realtime.startFile(session.id, file);
      await completeActive("completed");
      toast.success("音声ファイルの文字起こしを完了しました");
    } catch (error) {
      const message = error instanceof Error ? error.message : "音声ファイルを処理できません";
      setWorkspaceError(message);
      if (activeSessionRef.current) await completeActive("failed").catch(() => undefined);
      toast.error(message);
    } finally {
      setOperationBusy(false);
    }
  };

  const stopMicrophone = async () => {
    if (!activeSessionRef.current || operationBusy) return;
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
  const busy = operationBusy || realtime.capturing || realtime.finalizing;

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
          stage={status.stage}
          live={!historyId}
          loading={Boolean(historyId && detail.isPending)}
          error={workspaceError || detail.error?.message}
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
            stage={status.stage}
            connection={realtime.connection}
            capturing={realtime.capturing}
            finalizing={realtime.finalizing}
            busy={operationBusy}
            elapsedMs={elapsedMs}
            pendingSaves={pendingSaves}
            sourceLabel={realtime.sourceLabel}
            model={selectedModel}
            onMicrophone={() => void startMicrophone()}
            onFile={(file) => void startFile(file)}
            onStop={() => void stopMicrophone()}
          />
        )}
      </main>
      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        status={status}
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
