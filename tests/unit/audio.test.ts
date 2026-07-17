import { describe, expect, it } from "vitest";
import {
  appendPcmSamples,
  downsample,
  floatToPcm,
  PcmTimelineBuffer,
  pcmS16leToWav,
  sessionStart,
} from "../../src/audio";

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

  it("slices PCM across timeline chunk boundaries using absolute milliseconds", () => {
    const timeline = new PcmTimelineBuffer();
    timeline.append(new Int16Array([0, 1, 2]).buffer);
    timeline.append(new Int16Array([3, 4, 5]).buffer);

    expect(Array.from(timeline.slice(2, 5, 1_000))).toEqual([2, 3, 4]);
  });

  it("encodes mono signed 16-bit PCM with a valid WAV header", async () => {
    const wav = pcmS16leToWav(new Int16Array([-32_768, 0, 32_767]), 8_000);
    const buffer = await wav.arrayBuffer();
    const view = new DataView(buffer);
    const ascii = (offset: number, length: number) => String.fromCharCode(
      ...new Uint8Array(buffer, offset, length),
    );

    expect(wav.type).toBe("audio/wav");
    expect(wav.size).toBe(50);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(42);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8_000);
    expect(view.getUint32(28, true)).toBe(16_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(new Int16Array(buffer, 44))).toEqual([-32_768, 0, 32_767]);
  });
});
