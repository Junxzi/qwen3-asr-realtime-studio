import { RefreshCw } from "lucide-react";
import { assignmentMessage } from "@/assignment";
import { PipelineFlow } from "@/components/PipelineFlow";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatClock } from "@/lib/format";
import { pipelineDetailLabel, pipelineStatusLabel, type PipelineState } from "@/pipeline";
import type { AsrModel, ControlStatus, InferenceAssignment, ProcessingProfile, TranscriptionMetrics } from "@/types";

interface DiagnosticsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status?: ControlStatus;
  statusError?: string;
  assignments: InferenceAssignment[];
  connection: "disconnected" | "connecting" | "connected" | "error";
  elapsedMs: number;
  metrics: TranscriptionMetrics;
  pipeline: PipelineState;
  pendingSaves: number;
  model?: AsrModel;
  processingProfile?: ProcessingProfile;
  live: boolean;
  onRefresh: () => void;
}

function metric(value: number | null | undefined, unit = "") {
  return Number.isFinite(value) ? `${Math.round(value!)}${unit}` : "—";
}

function gpuMemory(used?: number, total?: number) {
  if (!Number.isFinite(used) && !Number.isFinite(total)) return "—";
  const format = (value: number) => `${(value / 1024).toFixed(1)} GB`;
  if (Number.isFinite(used) && Number.isFinite(total)) return `${format(used!)} / ${format(total!)}`;
  return Number.isFinite(used) ? format(used!) : format(total!);
}

function hourlyCost(value?: string | number) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}/h` : `${value}/h`;
}

export function DiagnosticsDrawer({
  open,
  onOpenChange,
  status,
  statusError,
  assignments,
  connection,
  elapsedMs,
  metrics,
  pipeline,
  pendingSaves,
  model,
  processingProfile,
  live,
  onRefresh,
}: DiagnosticsDrawerProps) {
  const connected = connection === "connected";
  const assignment = assignments[0];
  const assignedWorker = assignment?.worker;
  const health = assignedWorker?.health || status?.service.health;
  const pool = status?.pool;
  const batchMode = processingProfile?.id === "batch";
  const connectionLabel = batchMode ? "Batch API" : "WebSocket";
  const connectionState = batchMode
    ? connection === "connecting" ? "通信中"
      : connection === "connected" ? "応答済み"
        : connection === "error" ? "エラー" : "未接続"
    : connected ? "接続中" : "未接続";
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        id="diagnostics-panel"
        side="right"
        className="diagnostics-sheet"
        showClose={false}
        showOverlay={false}
      >
        <SheetHeader>
          <div>
            <SheetTitle>診断</SheetTitle>
            <SheetDescription className="sr-only">接続、遅延、Context、保存状態</SheetDescription>
          </div>
          <Button variant="icon" size="icon" onClick={onRefresh} aria-label="状態を更新">
            <RefreshCw />
          </Button>
        </SheetHeader>

        <PipelineFlow profile={processingProfile} state={pipeline} live={live} />

        <section className="diagnostic-section">
          <h2>接続 <span>(Connection)</span></h2>
          <dl>
            <div><dt>{connectionLabel}</dt><dd className={connected ? "metric-success" : ""}><i />{connectionState}</dd></div>
            <div><dt>接続時間</dt><dd>{formatClock(elapsedMs)}</dd></div>
            <div>
              <dt>割り当て</dt>
              <dd>{assignments.length
                ? assignments.map((item) => assignmentMessage(item)).join(" / ")
                : "未割り当て"}</dd>
            </div>
            <div><dt>保存待ち</dt><dd>{pendingSaves}件</dd></div>
          </dl>
        </section>

        <section className="diagnostic-section">
          <h2>割り当てWorker <span>(Assigned worker)</span></h2>
          {assignments.length ? assignments.map((item) => {
            const worker = item.worker;
            const workerHealth = worker?.health || (worker?.pod_id === status?.pod?.id ? status?.service.health : undefined);
            const assignmentGpu = worker?.gpu;
            const assignmentGpuName = worker?.gpu_type
              || workerHealth?.accelerator
              || assignmentGpu?.displayName
              || assignmentGpu?.id
              || "—";
            const running = ["ready", "busy", "running"].includes(worker?.status?.toLowerCase() || "")
              || item.status === "ready"
              || item.status === "active";
            const role = item.purpose === "realtime"
              ? "Context / Streaming"
              : processingProfile?.id === "hybrid" ? "高精度 Finalizer" : "高精度ファイル";
            return (
              <div className="diagnostic-worker" key={item.id}>
                <h3>{role}</h3>
                <dl>
                  <div><dt>状態</dt><dd className={running ? "metric-success" : ""}><i />{worker?.status || item.status}</dd></div>
                  <div><dt>Worker ID</dt><dd title={worker?.id}>{worker?.id || "—"}</dd></div>
                  <div><dt>RunPod ID</dt><dd title={worker?.pod_id}>{worker?.pod_id || "—"}</dd></div>
                  <div><dt>Worker名</dt><dd title={worker?.name}>{worker?.name || "—"}</dd></div>
                  <div><dt>GPU構成</dt><dd title={assignmentGpuName}>{assignmentGpuName}</dd></div>
                  <div><dt>台数</dt><dd>{typeof assignmentGpu?.count === "number" ? `${assignmentGpu.count}基` : "—"}</dd></div>
                  <div><dt>要求モデル</dt><dd title={item.model_id}>{item.model_id}</dd></div>
                  <div><dt>読込モデル</dt><dd title={worker?.loaded_model_id}>{worker?.loaded_model_id || "—"}</dd></div>
                  <div><dt>使用率</dt><dd>{metric(workerHealth?.gpu_utilization_percent, "%")}</dd></div>
                  <div><dt>VRAM</dt><dd>{gpuMemory(workerHealth?.gpu_memory_used_mb, workerHealth?.gpu_memory_total_mb)}</dd></div>
                  <div><dt>温度</dt><dd>{metric(workerHealth?.gpu_temperature_c, "°C")}</dd></div>
                  <div><dt>消費電力</dt><dd>{metric(workerHealth?.gpu_power_w, "W")}</dd></div>
                  <div><dt>時間単価</dt><dd>{worker?.pod_id === status?.pod?.id ? hourlyCost(status?.pod?.costPerHr) : "—"}</dd></div>
                </dl>
              </div>
            );
          }) : <p>GPUはまだ割り当てられていません。</p>}
        </section>

        <section className="diagnostic-section">
          <h2>GPUプール <span>(Worker pool)</span></h2>
          {pool ? (
            <dl>
              <div><dt>Worker</dt><dd>{pool.ready_workers} ready / {pool.total_workers} total</dd></div>
              <div><dt>利用中セッション</dt><dd>{pool.active_sessions}</dd></div>
              <div><dt>総容量</dt><dd>{pool.capacity}</dd></div>
              <div><dt>準備中</dt><dd>{pool.provisioning_assignments}</dd></div>
            </dl>
          ) : (
            <p>{statusError || (status ? "プール集計はまだ提供されていません。" : "プール状態を取得しています。")}</p>
          )}
        </section>

        <section className="diagnostic-section">
          <h2>レイテンシ <span>(Latency)</span></h2>
          <dl>
            <div><dt>Stable p95</dt><dd className="metric-success">{metric(metrics.stable_latency_p95_ms, "ms")}</dd></div>
            <div><dt>TTFT</dt><dd className="metric-success">{metric(metrics.ttft_ms, "ms")}</dd></div>
            <div><dt>Queue p95</dt><dd>{metric(metrics.queue_p95_ms, "ms")}</dd></div>
            <div><dt>RTF</dt><dd>{Number.isFinite(metrics.rtf) ? `${metrics.rtf!.toFixed(2)}x` : "—"}</dd></div>
          </dl>
        </section>

        <section className="diagnostic-section">
          <h2>コンテキスト <span>(Context)</span></h2>
          <dl>
            <div><dt>Context hits</dt><dd className="metric-success">{metric(metrics.context_hits)}</dd></div>
            <div><dt>カタログ</dt><dd>{health?.catalog_terms ? `${health.catalog_terms}語` : "—"}</dd></div>
            <div>
              <dt>Catalog revision</dt>
              <dd title={health?.catalog_revision}>
                {health?.catalog_revision || "—"}
              </dd>
            </div>
            <div><dt>選択モデル</dt><dd title={model?.id}>{model?.display_name || "—"}</dd></div>
            <div><dt>稼働モデル</dt><dd title={assignedWorker?.loaded_model_id}>{assignedWorker?.loaded_model_id || health?.model || "—"}</dd></div>
            <div><dt>実行方式</dt><dd>{model?.runtime === "batch" ? "ファイル一括" : model ? "リアルタイム" : "—"}</dd></div>
          </dl>
        </section>

        <section className="diagnostic-section diagnostic-events">
          <h2>イベント <span>(Events)</span></h2>
          {live && pipeline.log.length ? (
            <ol>
              {pipeline.log.map((event, index) => {
                const node = processingProfile?.nodes.find((candidate) => candidate.id === event.stage);
                const detail = pipelineDetailLabel(event.detail_code);
                const warning = event.status === "failed" || event.status === "fallback";
                return (
                  <li key={`${event.source}-${event.seq ?? "local"}-${event.received_at}-${index}`}>
                    <i className={warning ? "event-warning" : ""} />
                    <time dateTime={event.received_at}>
                      {new Date(event.received_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </time>
                    <span>{node?.label || "処理"} · {detail || pipelineStatusLabel(event.status)}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p>{live ? "実行イベントを待っています。" : "保存済み履歴ではライブイベントを保持していません。"}</p>
          )}
        </section>

        <p className="diagnostic-note">音声本体と部分結果はRailwayへ保存されません。</p>
      </SheetContent>
    </Sheet>
  );
}
