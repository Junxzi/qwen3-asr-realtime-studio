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
