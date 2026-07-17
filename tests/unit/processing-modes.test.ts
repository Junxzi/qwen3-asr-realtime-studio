import { describe, expect, it } from "vitest";
import {
  assignmentForPurpose,
  findProcessingProfile,
  inferProcessingMode,
  listProcessingProfiles,
} from "../../server/processing-modes.js";

const realtimeModelId = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft";
const finalModelId = "infodeliverailab/lab_asr_diarization_v1";

describe("processing mode catalog", () => {
  it("publishes the three fixed processing profiles with valid graph references", () => {
    const profiles = listProcessingProfiles();

    expect(profiles.map((profile) => profile.id)).toEqual(["realtime", "batch", "hybrid"]);
    expect(findProcessingProfile("batch")).toMatchObject({
      input_modes: ["file"],
      primary_model_id: finalModelId,
      final_model_id: null,
      assignments: [{ purpose: "batch", model_id: finalModelId }],
      availability: {
        selectable: true,
        configured: null,
        provisionable: null,
        validated: false,
        status: "unknown",
      },
    });
    expect(findProcessingProfile("hybrid")).toMatchObject({
      input_modes: ["microphone", "file"],
      primary_model_id: realtimeModelId,
      final_model_id: finalModelId,
      assignments: [
        { purpose: "realtime", model_id: realtimeModelId },
        { purpose: "batch", model_id: finalModelId },
      ],
    });

    for (const profile of profiles) {
      const nodeIds = new Set(profile.nodes.map((node) => node.id));
      expect(nodeIds.size).toBe(profile.nodes.length);
      for (const edge of profile.edges) {
        expect(nodeIds.has(edge.from)).toBe(true);
        expect(nodeIds.has(edge.to)).toBe(true);
      }
    }
  });

  it("publishes configuration and GPU-validation status without blocking a PoC selection", () => {
    const profiles = listProcessingProfiles({
      workers: [{
        enabled: true,
        modelId: realtimeModelId,
        runtime: "realtime",
      }],
      modelTemplates: [{
        modelId: finalModelId,
        runtime: "batch",
      }],
      canProvision: true,
    });

    expect(profiles.find((profile) => profile.id === "realtime")?.availability).toEqual({
      selectable: true,
      configured: true,
      provisionable: true,
      validated: true,
      status: "configured",
    });
    expect(profiles.find((profile) => profile.id === "batch")?.availability).toEqual({
      selectable: true,
      configured: false,
      provisionable: true,
      validated: false,
      status: "provisionable",
    });
    expect(profiles.find((profile) => profile.id === "hybrid")?.availability).toEqual({
      selectable: true,
      configured: false,
      provisionable: true,
      validated: false,
      status: "provisionable",
    });
  });

  it("does not advertise templates as provisionable for a readonly provider", () => {
    const profiles = listProcessingProfiles({
      workers: [],
      modelTemplates: [{ modelId: finalModelId, runtime: "batch" }],
      canProvision: false,
    });

    expect(profiles.find((profile) => profile.id === "batch")?.availability).toMatchObject({
      configured: false,
      provisionable: false,
      status: "setup_required",
    });
  });

  it("infers legacy requests and resolves only purposes supported by the selected mode", () => {
    expect(inferProcessingMode()).toBe("realtime");
    expect(inferProcessingMode(realtimeModelId)).toBe("realtime");
    expect(inferProcessingMode(finalModelId)).toBe("batch");
    expect(assignmentForPurpose("realtime", "batch")).toBeUndefined();
    expect(assignmentForPurpose("batch", "realtime")).toBeUndefined();
    expect(assignmentForPurpose("hybrid", "realtime")).toEqual({
      purpose: "realtime",
      model_id: realtimeModelId,
    });
    expect(assignmentForPurpose("hybrid", "batch")).toEqual({
      purpose: "batch",
      model_id: finalModelId,
    });
  });

  it("returns defensive copies of profiles", () => {
    const first = listProcessingProfiles();
    first[0].input_modes.length = 0;
    first[0].nodes[0].label = "mutated";
    first[0].edges.length = 0;

    const fresh = listProcessingProfiles()[0];
    expect(fresh.input_modes).toEqual(["microphone", "file"]);
    expect(fresh.nodes[0].label).not.toBe("mutated");
    expect(fresh.edges.length).toBeGreaterThan(0);
  });
});
