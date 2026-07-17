import { Check, CloudUpload, LoaderCircle, Mic, MicOff, RotateCcw, Square } from "lucide-react";
import { assignmentMessage } from "@/assignment";
import { formatClock } from "@/lib/format";
import type { AsrModel, InferenceAssignment, ProcessingProfile } from "@/types";

interface AudioComposerProps {
  assignment?: InferenceAssignment | null;
  connection: "disconnected" | "connecting" | "connected" | "error";
  capturing: boolean;
  finalizing: boolean;
  completionRetryRequired: boolean;
  busy: boolean;
  cancellable: boolean;
  elapsedMs: number;
  pendingSaves: number;
  sourceLabel: string;
  model?: AsrModel;
  processingProfile?: ProcessingProfile;
  onMicrophone: () => void;
  onFile: (file: File) => void;
  onStop: () => void;
  onRetryCompletion: () => void;
  onCancel: () => void;
}

export function AudioComposer({
  assignment,
  connection,
  capturing,
  finalizing,
  completionRetryRequired,
  busy,
  cancellable,
  elapsedMs,
  pendingSaves,
  sourceLabel,
  model,
  processingProfile,
  onMicrophone,
  onFile,
  onStop,
  onRetryCompletion,
  onCancel,
}: AudioComposerProps) {
  const active = capturing || finalizing || completionRetryRequired;
  const inputModes = processingProfile?.input_modes || model?.input_modes || [];
  const supportsMicrophone = inputModes.includes("microphone");
  const supportsFile = inputModes.includes("file");
  const batchOnly = processingProfile ? processingProfile.id === "batch" : model?.runtime === "batch";
  const status = completionRetryRequired
    ? "保存とGPU解放を再試行してください"
    : finalizing
    ? (batchOnly ? "ファイルを文字起こし中" : "発話を確定しています")
    : capturing
      ? "文字起こし中"
      : assignment && (assignment.status === "requested" || assignment.status === "provisioning" || assignment.status === "failed")
        ? assignmentMessage(assignment, model?.display_name)
        : connection === "connecting"
          ? "割り当て先GPUへ接続しています"
          : assignment && (assignment.status === "ready" || assignment.status === "active")
            ? assignmentMessage(assignment, model?.display_name)
            : busy
              ? "GPUの割り当てを要求しています"
              : !model
                ? "モデル情報を読み込んでいます"
              : batchOnly ? "音声ファイルを選択" : "文字起こしを開始";

  return (
    <div className="composer-wrap">
      <div className={`save-state ${pendingSaves ? "save-state--pending" : ""}`} aria-live="polite">
        {pendingSaves ? <><LoaderCircle className="spin" />保存待ち {pendingSaves}件</> : <><Check />保存済み</>}
      </div>
      <div className={`audio-composer ${active ? "is-active" : ""}`}>
        <label className={`composer-upload ${!supportsFile || active || busy ? "is-disabled" : ""}`}>
          <CloudUpload aria-hidden="true" />
          <span>
            <strong>ファイルをアップロード</strong>
            <small>{active && sourceLabel !== "未選択" ? sourceLabel : "音声 / 動画を選択"}</small>
          </span>
          <input
            type="file"
            accept="audio/*,video/*"
            disabled={!supportsFile || active || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              event.target.value = "";
            }}
          />
        </label>

        <div className={`composer-wave ${capturing ? "is-recording" : ""}`} aria-hidden="true">
          {[8, 18, 28, 14, 34, 22, 12, 30, 20, 10, 24, 14, 32, 18, 8].map((height, index) => (
            <i key={`${height}-${index}`} style={{ height }} />
          ))}
        </div>

        <div className="composer-status" aria-live="polite">
          <span><i className={capturing ? "is-live" : ""} />{status}</span>
          <time>{formatClock(elapsedMs)}</time>
        </div>

        <button
          className="composer-action"
          onClick={completionRetryRequired ? onRetryCompletion : cancellable ? onCancel : active ? onStop : onMicrophone}
          disabled={completionRetryRequired ? busy : cancellable ? false : !supportsMicrophone || busy || finalizing}
          aria-label={completionRetryRequired ? "保存とGPU解放を再試行" : cancellable ? "処理を中止" : active ? "文字起こしを停止" : supportsMicrophone ? "マイクで文字起こしを開始" : "このモデルはファイル専用です"}
          title={!supportsMicrophone ? "このモデルはファイル専用です" : undefined}
        >
          {completionRetryRequired
            ? busy ? <LoaderCircle className="spin" /> : <RotateCcw />
            : cancellable
            ? <Square />
            : finalizing || connection === "connecting"
            ? <LoaderCircle className="spin" />
            : active
              ? <Square />
              : supportsMicrophone
                ? <Mic />
                : <MicOff />}
        </button>
      </div>
    </div>
  );
}
