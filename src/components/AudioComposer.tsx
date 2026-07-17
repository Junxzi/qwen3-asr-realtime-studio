import { Check, CloudUpload, LoaderCircle, Mic, MicOff, Square } from "lucide-react";
import { formatClock } from "@/lib/format";
import type { AsrModel, ControlStage } from "@/types";

interface AudioComposerProps {
  stage: ControlStage;
  connection: "disconnected" | "connecting" | "connected" | "error";
  capturing: boolean;
  finalizing: boolean;
  busy: boolean;
  elapsedMs: number;
  pendingSaves: number;
  sourceLabel: string;
  model?: AsrModel;
  onMicrophone: () => void;
  onFile: (file: File) => void;
  onStop: () => void;
}

export function AudioComposer({
  stage,
  connection,
  capturing,
  finalizing,
  busy,
  elapsedMs,
  pendingSaves,
  sourceLabel,
  model,
  onMicrophone,
  onFile,
  onStop,
}: AudioComposerProps) {
  const ready = stage === "ready";
  const active = capturing || finalizing;
  const supportsMicrophone = Boolean(model?.input_modes.includes("microphone"));
  const supportsFile = Boolean(model?.input_modes.includes("file"));
  const status = finalizing
    ? (model?.runtime === "batch" ? "ファイルを文字起こし中" : "発話を確定しています")
    : capturing
      ? "文字起こし中"
      : connection === "connecting"
        ? "接続しています"
        : ready
          ? (model?.runtime === "batch" ? "音声ファイルを選択" : "文字起こしを開始")
          : "GPUの起動を待っています";

  return (
    <div className="composer-wrap">
      <div className={`save-state ${pendingSaves ? "save-state--pending" : ""}`} aria-live="polite">
        {pendingSaves ? <><LoaderCircle className="spin" />保存待ち {pendingSaves}件</> : <><Check />保存済み</>}
      </div>
      <div className={`audio-composer ${active ? "is-active" : ""}`}>
        <label className={`composer-upload ${!ready || !supportsFile || active || busy ? "is-disabled" : ""}`}>
          <CloudUpload aria-hidden="true" />
          <span>
            <strong>ファイルをアップロード</strong>
            <small>{active && sourceLabel !== "未選択" ? sourceLabel : "音声 / 動画を選択"}</small>
          </span>
          <input
            type="file"
            accept="audio/*,video/*"
            disabled={!ready || !supportsFile || active || busy}
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

        <div className="composer-status">
          <span><i className={capturing ? "is-live" : ""} />{status}</span>
          <time>{formatClock(elapsedMs)}</time>
        </div>

        <button
          className="composer-action"
          onClick={active ? onStop : onMicrophone}
          disabled={!ready || !supportsMicrophone || busy || finalizing}
          aria-label={active ? "文字起こしを停止" : supportsMicrophone ? "マイクで文字起こしを開始" : "このモデルはファイル専用です"}
          title={!supportsMicrophone ? "このモデルはファイル専用です" : undefined}
        >
          {finalizing || connection === "connecting"
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
