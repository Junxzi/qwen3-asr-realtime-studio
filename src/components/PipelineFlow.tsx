import {
  Activity,
  Check,
  Circle,
  Clock3,
  Database,
  FileAudio,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  Split,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { memo } from "react";
import { latestPipelineStages, pipelineDetailLabel, pipelineStatusLabel, type PipelineState } from "@/pipeline";
import type { PipelineNodeId, PipelineStatus, ProcessingPipelineNode, ProcessingProfile } from "@/types";

interface PipelineFlowProps {
  profile?: ProcessingProfile;
  state: PipelineState;
  live: boolean;
}

const NODE_ICONS = {
  audio_ingest: FileAudio,
  vad: Activity,
  context_asr: MessageSquareText,
  streaming_sortformer: Users,
  endpoint: Split,
  lab_finalizer: Sparkles,
  replace_result: RefreshCw,
  persist: Database,
} satisfies Record<PipelineNodeId, typeof Activity>;

const STATUS_ICONS = {
  waiting: Circle,
  queued: Clock3,
  running: LoaderCircle,
  completed: Check,
  fallback: TriangleAlert,
  failed: X,
} satisfies Record<PipelineStatus, typeof Circle>;

export function pipelineRows(profile: ProcessingProfile): ProcessingPipelineNode[][] {
  const depths = new Map(profile.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < profile.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of profile.edges) {
      const nextDepth = (depths.get(edge.from) || 0) + 1;
      if (nextDepth > (depths.get(edge.to) || 0)) {
        depths.set(edge.to, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, ProcessingPipelineNode[]>();
  for (const node of profile.nodes) {
    const depth = depths.get(node.id) || 0;
    rows.set(depth, [...(rows.get(depth) || []), node]);
  }
  return [...rows.entries()].sort(([left], [right]) => left - right).map(([, nodes]) => nodes);
}

function statusSummary(profile: ProcessingProfile, state: PipelineState) {
  const entry = state.log[0];
  if (!entry) return "実行イベントを待っています";
  const node = profile.nodes.find((candidate) => candidate.id === entry.stage);
  const detail = pipelineDetailLabel(entry.detail_code);
  return `${node?.label || "処理"}：${pipelineStatusLabel(entry.status)}${detail ? ` · ${detail}` : ""}`;
}

export const PipelineFlow = memo(function PipelineFlow({ profile, state, live }: PipelineFlowProps) {
  if (!profile) {
    return (
      <section className="diagnostic-section pipeline-flow-section" aria-label="処理フロー">
        <h2>処理フロー <span>(Live pipeline)</span></h2>
        <p>処理方式を読み込んでいます。</p>
      </section>
    );
  }

  const stages = latestPipelineStages(state);
  const rows = pipelineRows(profile);
  return (
    <section className="diagnostic-section pipeline-flow-section" aria-labelledby="pipeline-flow-title">
      <div className="pipeline-flow-heading">
        <h2 id="pipeline-flow-title">処理フロー <span>(Live pipeline)</span></h2>
        <small>{profile.display_name}</small>
      </div>
      <p className="pipeline-flow-summary" role="status" aria-live="polite" aria-atomic="true">
        {live ? statusSummary(profile, state) : "保存済み履歴では実行イベントを保持していません"}
      </p>
      <ol className="pipeline-flow" aria-label={`${profile.display_name}の処理工程`}>
        {rows.map((row, rowIndex) => (
          <li className="pipeline-flow-row-wrap" key={row.map((node) => node.id).join("-")}>
            {rowIndex ? <span className="pipeline-flow-connector" aria-hidden="true" /> : null}
            <ol className={`pipeline-flow-row pipeline-flow-row--${Math.min(row.length, 3)}`}>
              {row.map((node) => {
                const snapshot = live ? stages[node.id] : undefined;
                const status = snapshot?.status || "waiting";
                const NodeIcon = NODE_ICONS[node.id];
                const StatusIcon = STATUS_ICONS[status];
                const detail = pipelineDetailLabel(snapshot?.detailCode || null);
                return (
                  <li
                    className={`pipeline-node pipeline-node--${status}`}
                    key={node.id}
                    aria-label={`${node.label}、${pipelineStatusLabel(status)}${detail ? `、${detail}` : ""}`}
                  >
                    <span className="pipeline-node-icon"><NodeIcon aria-hidden="true" /></span>
                    <span className="pipeline-node-copy">
                      <strong>{node.label}</strong>
                      <small>{detail || pipelineStatusLabel(status)}</small>
                    </span>
                    <span className="pipeline-node-status" data-status={status}>
                      <StatusIcon className={status === "running" ? "spin" : undefined} aria-hidden="true" />
                      <span>{pipelineStatusLabel(status)}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      <p className="pipeline-flow-note">工程はWorkerまたは保存処理から実イベントを受信した時だけ更新されます。</p>
    </section>
  );
});
