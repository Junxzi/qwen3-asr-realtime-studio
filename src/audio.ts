export const SAMPLE_RATE = 16_000;
export const MIN_FRAME_SAMPLES = SAMPLE_RATE * 0.02;

export function appendPcmSamples(pending: Float32Array, incoming: Float32Array, frameSamples = MIN_FRAME_SAMPLES) {
  const merged = new Float32Array(pending.length + incoming.length);
  merged.set(pending);
  merged.set(incoming, pending.length);
  const sendableLength = Math.floor(merged.length / frameSamples) * frameSamples;
  return {
    sendable: merged.slice(0, sendableLength),
    pending: merged.slice(sendableLength),
  };
}

export function downsample(input: Float32Array, inputRate: number, outputRate = SAMPLE_RATE) {
  if (inputRate === outputRate) return new Float32Array(input);
  if (inputRate < outputRate) throw new Error(`入力サンプルレート ${inputRate} Hz は未対応です`);
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let total = 0;
    for (let inputIndex = start; inputIndex < Math.max(start + 1, end); inputIndex += 1) total += input[inputIndex] || 0;
    output[outputIndex] = total / Math.max(1, end - start);
  }
  return output;
}

export function floatToPcm(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

export class PcmTimelineBuffer {
  private chunks: Int16Array[] = [];
  private sampleCount = 0;

  append(buffer: ArrayBuffer) {
    const chunk = new Int16Array(buffer.slice(0));
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.sampleCount += chunk.length;
  }

  clear() {
    this.chunks = [];
    this.sampleCount = 0;
  }

  slice(startMs: number, endMs: number, sampleRate = SAMPLE_RATE) {
    const startSample = Math.max(0, Math.floor(startMs * sampleRate / 1000));
    const endSample = Math.min(this.sampleCount, Math.ceil(endMs * sampleRate / 1000));
    if (endSample <= startSample) throw new Error("発話音声の範囲を取得できませんでした");
    const output = new Int16Array(endSample - startSample);
    let timelineOffset = 0;
    let outputOffset = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = timelineOffset + chunk.length;
      if (chunkEnd > startSample && timelineOffset < endSample) {
        const localStart = Math.max(0, startSample - timelineOffset);
        const localEnd = Math.min(chunk.length, endSample - timelineOffset);
        const portion = chunk.subarray(localStart, localEnd);
        output.set(portion, outputOffset);
        outputOffset += portion.length;
      }
      timelineOffset = chunkEnd;
      if (timelineOffset >= endSample) break;
    }
    return output;
  }
}

export function pcmS16leToWav(samples: Int16Array, sampleRate = SAMPLE_RATE) {
  const headerBytes = 44;
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(headerBytes + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  new Int16Array(buffer, headerBytes).set(samples);
  return new Blob([buffer], { type: "audio/wav" });
}

export function sessionStart(sessionId: string, catalogRevision: string, modelId: string, connectionTicket: string) {
  return {
    type: "session.start" as const,
    session_id: sessionId,
    sample_rate: SAMPLE_RATE,
    encoding: "pcm_s16le" as const,
    catalog_revision: catalogRevision,
    model_id: modelId,
    connection_ticket: connectionTicket,
  };
}

export async function decodeAudioFile(file: File) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const mixed = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const source = decoded.getChannelData(channel);
      for (let index = 0; index < source.length; index += 1) mixed[index] += source[index] / decoded.numberOfChannels;
    }
    return downsample(mixed, decoded.sampleRate);
  } finally {
    await context.close();
  }
}
