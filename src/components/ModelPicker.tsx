import { RadioTower, Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AsrModel } from "@/types";

interface ModelPickerProps {
  models: AsrModel[];
  value: string;
  disabled?: boolean;
  readOnly?: boolean;
  onChange: (modelId: string) => void;
}

function option(model: AsrModel) {
  const Icon = model.runtime === "realtime" ? RadioTower : Sparkles;
  return (
    <span className="model-option">
      <Icon aria-hidden="true" />
      <span>
        <strong>{model.display_name}</strong>
        <small>
          {model.runtime === "realtime" ? "リアルタイム" : "ファイル一括"}
          {" · "}
          {model.estimated_vram_gb}GB+
        </small>
      </span>
    </span>
  );
}

export function ModelPicker({ models, value, disabled, readOnly, onChange }: ModelPickerProps) {
  const selected = models.find((model) => model.id === value);

  if (readOnly) {
    return (
      <span className="model-readonly" title={selected?.id || value}>
        {selected?.short_name || value.split("/").at(-1) || value}
      </span>
    );
  }

  const realtimeModels = models.filter((model) => model.runtime === "realtime");
  const batchModels = models.filter((model) => model.runtime === "batch");

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="model-select-trigger" aria-label="文字起こしモデル">
        <SelectValue>{selected?.short_name || "モデルを選択"}</SelectValue>
      </SelectTrigger>
      <SelectContent className="model-select-content" position="popper" align="end">
        {realtimeModels.length ? (
          <SelectGroup>
            <SelectLabel>リアルタイム向け</SelectLabel>
            {realtimeModels.map((model) => (
              <SelectItem key={model.id} value={model.id} textValue={model.display_name}>
                {option(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {batchModels.length ? (
          <SelectGroup>
            <SelectLabel>高品質・ファイル向け</SelectLabel>
            {batchModels.map((model) => (
              <SelectItem key={model.id} value={model.id} textValue={model.display_name}>
                {option(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
