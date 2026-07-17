export type AsrRuntime = "realtime" | "batch";
export type AsrInputMode = "microphone" | "file";

export interface AsrModelDescriptor {
  id: string;
  display_name: string;
  short_name: string;
  description: string;
  runtime: AsrRuntime;
  input_modes: AsrInputMode[];
  supports_context: boolean;
  supports_diarization: boolean;
  recommended: boolean;
  estimated_vram_gb: number;
  source: "private_model" | "public_recipe";
}

export const DEFAULT_ASR_MODEL_ID = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";

const ASR_MODELS: readonly AsrModelDescriptor[] = [
  {
    id: DEFAULT_ASR_MODEL_ID,
    display_name: "Context Full-FT 1.7B",
    short_name: "Context 1.7B",
    description: "証券用語Contextと低遅延部分結果に対応するリアルタイム向けモデル",
    runtime: "realtime",
    input_modes: ["microphone", "file"],
    supports_context: true,
    supports_diarization: true,
    recommended: true,
    estimated_vram_gb: 32,
    source: "private_model",
  },
  {
    id: "infodeliverailab/qwen3-omni-jp-vllm",
    display_name: "Qwen3-Omni 30B-A3B",
    short_name: "Omni 30B",
    description: "ファイル一括処理で話者タグと高品質な日本語文字起こしを生成する最新レシピ",
    runtime: "batch",
    input_modes: ["file"],
    supports_context: false,
    supports_diarization: true,
    recommended: false,
    estimated_vram_gb: 70,
    source: "public_recipe",
  },
] as const;

export function listAsrModels() {
  return ASR_MODELS.map((model) => ({ ...model, input_modes: [...model.input_modes] }));
}

export function isSupportedAsrModel(modelId: string) {
  return ASR_MODELS.some((model) => model.id === modelId);
}
