import { FileAudio, RadioTower, Workflow } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProcessingMode, ProcessingProfile } from "@/types";

interface ProcessingModePickerProps {
  modes: ProcessingProfile[];
  value: ProcessingMode;
  disabled?: boolean;
  readOnly?: boolean;
  onChange: (mode: ProcessingMode) => void;
}

const MODE_NAMES: Record<ProcessingMode, string> = {
  realtime: "高速リアルタイム",
  batch: "高精度ファイル",
  hybrid: "ライブ＋高精度確定",
};

type AvailabilityTone = "ready" | "provisionable" | "validation" | "setup" | "unknown";

export function processingModeAvailability(mode: ProcessingProfile): {
  label: string;
  tone: AvailabilityTone;
} {
  const availability = mode.availability;
  if (!availability) return { label: "状態未確認", tone: "unknown" };
  if (!availability.selectable) return { label: "利用準備中", tone: "setup" };
  if (availability.status === "setup_required") return { label: "GPU設定が必要", tone: "setup" };
  if (availability.status === "provisionable") return { label: "GPU起動で利用可", tone: "provisionable" };
  if (!availability.validated) return { label: "実GPU検証待ち", tone: "validation" };
  if (availability.status === "configured") return { label: "GPU接続設定済み", tone: "ready" };
  return { label: "状態未確認", tone: "unknown" };
}

function AvailabilityBadge({ mode }: { mode: ProcessingProfile }) {
  const availability = processingModeAvailability(mode);
  return (
    <span className="processing-mode-availability" data-tone={availability.tone}>
      {availability.label}
    </span>
  );
}

function modeIcon(mode: ProcessingMode) {
  if (mode === "batch") return FileAudio;
  if (mode === "hybrid") return Workflow;
  return RadioTower;
}

function inputLabel(mode: ProcessingProfile) {
  const microphone = mode.input_modes.includes("microphone");
  const file = mode.input_modes.includes("file");
  if (microphone && file) return "マイク・ファイル";
  if (microphone) return "マイク";
  return "ファイル専用";
}

function option(mode: ProcessingProfile) {
  const Icon = modeIcon(mode.id);
  return (
    <span className="processing-mode-option">
      <Icon aria-hidden="true" />
      <span className="processing-mode-option-copy">
        <span className="processing-mode-option-title">
          <strong>{MODE_NAMES[mode.id]}</strong>
          <AvailabilityBadge mode={mode} />
        </span>
        <small>{inputLabel(mode)} · {mode.description}</small>
      </span>
    </span>
  );
}

export function ProcessingModePicker({ modes, value, disabled, readOnly, onChange }: ProcessingModePickerProps) {
  const selected = modes.find((mode) => mode.id === value);

  if (readOnly) {
    return (
      <span className="processing-mode-readonly">
        <span>{selected ? MODE_NAMES[selected.id] : "処理方式不明"}</span>
        {selected ? <AvailabilityBadge mode={selected} /> : null}
      </span>
    );
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (modes.some((mode) => mode.id === next)) onChange(next as ProcessingMode);
      }}
      disabled={disabled || !modes.length}
    >
      <SelectTrigger className="processing-mode-trigger" aria-label="処理方式">
        <SelectValue>
          <span className="processing-mode-value">
            <span>{selected ? MODE_NAMES[selected.id] : "処理方式を選択"}</span>
            {selected ? <AvailabilityBadge mode={selected} /> : null}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="processing-mode-content" position="popper" align="end">
        <SelectGroup>
          <SelectLabel>処理方式</SelectLabel>
          {modes.map((mode) => (
            <SelectItem
              key={mode.id}
              value={mode.id}
              textValue={`${MODE_NAMES[mode.id]} ${processingModeAvailability(mode).label}`}
            >
              {option(mode)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
