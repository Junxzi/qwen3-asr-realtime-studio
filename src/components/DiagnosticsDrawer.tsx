import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatClock } from "@/lib/format";
import type { AsrModel, ControlStatus, TranscriptionMetrics } from "@/types";

interface DiagnosticsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ControlStatus;
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
  connection,
  elapsedMs,
  metrics,
  events,
  pendingSaves,
  model,
  onRefresh,
}: DiagnosticsDrawerProps) {
  const connected = connection === "connected" || status.service.ready;
  const gpu = status.pod.gpu;
  const health = status.service.health;
  const gpuName = health?.accelerator || gpu?.displayName || gpu?.id || "—";
  const gpuRunning = status.pod.desiredStatus === "RUNNING";
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
            <div><dt>RunPod</dt><dd>{status.pod.desiredStatus}</dd></div>
            <div><dt>保存待ち</dt><dd>{pendingSaves}件</dd></div>
          </dl>
        </section>

        <section className="diagnostic-section">
          <h2>GPU <span>(Accelerator)</span></h2>
          <dl>
            <div>
              <dt>状態</dt>
              <dd className={gpuRunning ? "metric-success" : ""}>
                <i />{status.pod.desiredStatus}
              </dd>
            </div>
            <div><dt>GPU構成</dt><dd title={gpuName}>{gpuName}</dd></div>
            <div><dt>台数</dt><dd>{gpu?.count ? `${gpu.count}基` : "—"}</dd></div>
            <div><dt>ASR readiness</dt><dd className={status.service.ready ? "metric-success" : ""}>{status.service.ready ? "Ready" : "停止中"}</dd></div>
            <div><dt>使用率</dt><dd>{metric(health?.gpu_utilization_percent, "%")}</dd></div>
            <div><dt>VRAM</dt><dd>{gpuMemory(health?.gpu_memory_used_mb, health?.gpu_memory_total_mb)}</dd></div>
            <div><dt>温度</dt><dd>{metric(health?.gpu_temperature_c, "°C")}</dd></div>
            <div><dt>消費電力</dt><dd>{metric(health?.gpu_power_w, "W")}</dd></div>
            <div><dt>時間単価</dt><dd>{hourlyCost(status.pod.costPerHr)}</dd></div>
          </dl>
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
            <div><dt>カタログ</dt><dd>{status.service.health?.catalog_terms ? `${status.service.health.catalog_terms}語` : "—"}</dd></div>
            <div>
              <dt>Catalog revision</dt>
              <dd title={status.service.health?.catalog_revision}>
                {status.service.health?.catalog_revision || "—"}
              </dd>
            </div>
            <div><dt>選択モデル</dt><dd title={model?.id}>{model?.display_name || "—"}</dd></div>
            <div><dt>稼働モデル</dt><dd title={status.service.health?.model}>{status.service.health?.model || "—"}</dd></div>
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
