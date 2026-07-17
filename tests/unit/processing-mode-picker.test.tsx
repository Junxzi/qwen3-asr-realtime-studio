// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProcessingModePicker,
  processingModeAvailability,
} from "../../src/components/ProcessingModePicker";
import type { ProcessingProfile } from "../../src/types";

const labProfile: ProcessingProfile = {
  id: "batch",
  display_name: "高精度ファイル",
  description: "話者付き最終文字起こし",
  input_modes: ["file"],
  primary_model_id: "infodeliverailab/lab_asr_diarization_v1",
  final_model_id: null,
  assignments: [{ purpose: "batch", model_id: "infodeliverailab/lab_asr_diarization_v1" }],
  nodes: [{ id: "lab_finalizer", label: "Lab ASR + diarization" }],
  edges: [],
  availability: {
    selectable: true,
    configured: true,
    provisionable: true,
    validated: false,
    status: "configured",
  },
};

describe("ProcessingModePicker availability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("labels an unvalidated lab model honestly without disabling selection", async () => {
    await act(async () => root.render(
      <ProcessingModePicker
        modes={[labProfile]}
        value="batch"
        onChange={() => undefined}
      />,
    ));

    const trigger = container.querySelector<HTMLButtonElement>("[role=combobox]");
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.textContent).toContain("高精度ファイル");
    expect(trigger?.textContent).toContain("実GPU検証待ち");
  });

  it("keeps the validation state visible in read-only history", async () => {
    await act(async () => root.render(
      <ProcessingModePicker
        modes={[labProfile]}
        value="batch"
        readOnly
        onChange={() => undefined}
      />,
    ));

    expect(container.textContent).toContain("高精度ファイル");
    expect(container.textContent).toContain("実GPU検証待ち");
  });

  it("falls back safely while an older control plane omits availability", () => {
    const legacyProfile = { ...labProfile, availability: undefined };
    expect(processingModeAvailability(legacyProfile)).toEqual({
      label: "状態未確認",
      tone: "unknown",
    });
  });

  it("shows missing GPU configuration before model validation", () => {
    const unconfigured = {
      ...labProfile,
      availability: {
        ...labProfile.availability!,
        configured: false,
        provisionable: false,
        status: "setup_required" as const,
      },
    };
    expect(processingModeAvailability(unconfigured)).toEqual({
      label: "GPU設定が必要",
      tone: "setup",
    });
  });
});
