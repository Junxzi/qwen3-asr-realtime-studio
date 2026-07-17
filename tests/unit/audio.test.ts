import { describe, expect, it } from "vitest";
import { appendPcmSamples, downsample, floatToPcm, sessionStart } from "../../src/audio";

describe("realtime audio contract", () => {
  it("creates the exact session.start contract", () => {
    expect(sessionStart("session-1", "catalog-1", "infodeliverailab/context", "worker-ticket-1")).toEqual({
      type: "session.start",
      session_id: "session-1",
      sample_rate: 16000,
      encoding: "pcm_s16le",
      catalog_revision: "catalog-1",
      model_id: "infodeliverailab/context",
      connection_ticket: "worker-ticket-1",
    });
  });

  it("converts normalized floats to signed 16-bit PCM", () => {
    expect(Array.from(new Int16Array(floatToPcm(new Float32Array([-1, 0, 1]))))).toEqual([-32768, 0, 32767]);
  });

  it("downsamples 48kHz input to 16kHz", () => {
    const input = new Float32Array(480).fill(0.5);
    const output = downsample(input, 48000);
    expect(output).toHaveLength(160);
    expect(output[0]).toBeCloseTo(0.5);
  });

  it("buffers small AudioWorklet chunks into server-valid 20 ms frames", () => {
    let pending = new Float32Array();
    let sentSamples = 0;

    for (let index = 0; index < 8; index += 1) {
      const buffered = appendPcmSamples(pending, new Float32Array(42).fill(0.25));
      pending = buffered.pending;
      sentSamples += buffered.sendable.length;
    }

    expect(sentSamples).toBe(320);
    expect(pending).toHaveLength(16);
  });
});
