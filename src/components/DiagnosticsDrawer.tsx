import { RefreshCw } from "lucide-react";
import { assignmentMessage } from "@/assignment";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatClock } from "@/lib/format";
import type { AsrModel, ControlStatus, InferenceAssignment, TranscriptionMetrics } from "@/types";

interface DiagnosticsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status?: ControlStatus;
  statusError?: string;
  assignment?: InferenceAssignment | null;
  connection: "disconnected" | "connecting" | "connected" | "error";
  elapsedMs: number;
  metrics: TranscriptionMetrics;
  events: string[];
  pendingSaves: number;
  model?: AsrModel;
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
  assignment,
  connection,
  elapsedMs,
  metrics,
  events,
  pendingSaves,
  model,
  onRefresh,
}: DiagnosticsDrawerProps) {
  const connected = connection === "connected";
  const gpu = status?.pod?.gpu;
  const assignedWorker = assignment?.worker;
  const health = assignedWorker?.health || status?.service.health;
  const assignedGpu = assignedWorker?.gpu;
  const gpuName = assignedWorker?.gpu_type || health?.accelerator || gpu?.displayName || gpu?.id || "—";
  const workerRunning = ["ready", "busy", "running"].includes(assignedWorker?.status?.toLowerCase() || "");
  const gpuRunning = assignedWorker ? workerRunning : status?.pod?.desiredStatus === "RUNNING";
  const telemetryMatchesWorker = Boolean(assignedWorker?.health) || !assignedWorker || assignedWorker.pod_id === status?.pod?.id;
  const pool = status?.pool;
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

        <section className="diagnostic-section">
          <h2>接続 <span>(Connection)</span></h2>
          <dl>
            <div><dt>WebSocket</dt><dd className={connected ? "metric-success" : ""}><i />{connected ? "接続中" : "未接続"}</dd></div>
            <div><dt>接続時間</dt><dd>{formatClock(elapsedMs)}</dd></div>
            <div><dt>割り当て</dt><dd>{assignment ? assignmentMessage(assignment, model?.display_name) : "未割り当て"}</dd></div>
            <div><dt>保存待ち</dt><dd>{pendingSaves}件</dd></div>
          </dl>
        </section>

        <section className="diagnostic-section">
          <h2>割り当てWorker <span>(Assigned worker)</span></h2>
          <dl>
            <div>
              <dt>状態</dt>
              <dd className={gpuRunning ? "metric-success" : ""}>
                <i />{assignedWorker?.status || assignment?.status || "未割り当て"}
              </dd>
            </div>
            <div><dt>Worker ID</dt><dd title={assignedWorker?.id}>{assignedWorker?.id || "—"}</dd></div>
            <div><dt>RunPod ID</dt><dd title={assignedWorker?.pod_id}>{assignedWorker?.pod_id || "—"}</dd></div>
            <div><dt>Worker名</dt><dd title={assignedWorker?.name}>{assignedWorker?.name || "—"}</dd></div>
            <div><dt>GPU構成</dt><dd title={gpuName}>{gpuName}</dd></div>
            <div><dt>台数</dt><dd>{typeof assignedGpu?.count === "number" ? `${assignedGpu.count}基` : telemetryMatchesWorker && gpu?.count ? `${gpu.count}基` : "—"}</dd></div>
            <div><dt>要求モデル</dt><dd title={assignment?.model_id}>{assignment?.model_id || model?.id || "—"}</dd></div>
            <div><dt>読込モデル</dt><dd title={assignedWorker?.loaded_model_id}>{assignedWorker?.loaded_model_id || "—"}</dd></div>
            <div><dt>使用率</dt><dd>{telemetryMatchesWorker ? metric(health?.gpu_utilization_percent, "%") : "—"}</dd></div>
            <div><dt>VRAM</dt><dd>{telemetryMatchesWorker ? gpuMemory(health?.gpu_memory_used_mb, health?.gpu_memory_total_mb) : "—"}</dd></div>
            <div><dt>温度</dt><dd>{telemetryMatchesWorker ? metric(health?.gpu_temperature_c, "°C") : "—"}</dd></div>
            <div><dt>消費電力</dt><dd>{telemetryMatchesWorker ? metric(health?.gpu_power_w, "W") : "—"}</dd></div>
            <div><dt>時間単価</dt><dd>{telemetryMatchesWorker ? hourlyCost(status?.pod?.costPerHr) : "—"}</dd></div>
          </dl>
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
          {events.length ? (
            <ol>
              {events.map((event, index) => (
                <li key={`${event}-${index}`}>
                  <i className={event.includes("失敗") || event.includes("エラー") ? "event-warning" : ""} />
                  <time>{new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <span>{event}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>保存済み履歴ではライブイベントを保持していません。</p>
          )}
        </section>

        <p className="diagnostic-note">音声本体と部分結果はRailwayへ保存されません。</p>
      </SheetContent>
    </Sheet>
  );
}
