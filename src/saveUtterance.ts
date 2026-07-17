import { api } from "./api";
import type { FinalEvent, PersistUtteranceInput, TranscriptUtterance } from "./types";

export const SAVE_UTTERANCE_TIMEOUT_MS = 10_000;

type SaveUtterance = (
  sessionId: string,
  utteranceId: string,
  payload: PersistUtteranceInput,
  signal?: AbortSignal,
) => Promise<TranscriptUtterance>;

export function shouldReportFinalPersistence(event: FinalEvent) {
  return event.finalization_status !== "pending";
}

export async function saveUtteranceWithTimeout(
  sessionId: string,
  utteranceId: string,
  payload: PersistUtteranceInput,
  timeoutMs = SAVE_UTTERANCE_TIMEOUT_MS,
  save: SaveUtterance = api.saveUtterance,
) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException("文字起こしの保存がタイムアウトしました", "TimeoutError"));
  }, timeoutMs);
  try {
    return await save(sessionId, utteranceId, payload, controller.signal);
  } finally {
    globalThis.clearTimeout(timer);
  }
}
