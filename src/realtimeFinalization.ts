export const FINALIZATION_ACK_TIMEOUT_MS = 10_000;
export const LEGACY_FINALIZATION_QUIET_MS = 1_000;
export const LEGACY_FINALIZATION_TIMEOUT_MS = 5_000;

export type FinalizationMode = "ack" | "legacy";
export type FinalizationResult = "acknowledged" | "tail-final" | "quiet" | "timeout";

interface FinalizationDrainOptions {
  mode: FinalizationMode;
  pendingUtteranceId?: string | null;
  quietMs?: number;
  timeoutMs?: number;
}

/**
 * Coordinates the ordered end of one realtime input stream.
 *
 * New workers resolve only after stream.finalized. Legacy workers cannot prove
 * completion, so they wait for the pending utterance's final or a quiet window,
 * with a hard upper bound to avoid hanging the UI forever.
 */
export class FinalizationDrain {
  private readonly mode: FinalizationMode;
  private readonly quietMs: number;
  private readonly timeoutMs: number;
  private pendingUtteranceId: string | null;
  private tailFinalSeen = false;
  private acknowledged = false;
  private failure: Error | null = null;
  private started = false;
  private settled = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: ((result: FinalizationResult) => void) | null = null;
  private rejectWait: ((error: Error) => void) | null = null;
  private waitPromise: Promise<FinalizationResult> | null = null;

  constructor(options: FinalizationDrainOptions) {
    this.mode = options.mode;
    this.pendingUtteranceId = options.pendingUtteranceId || null;
    this.quietMs = options.quietMs ?? LEGACY_FINALIZATION_QUIET_MS;
    this.timeoutMs = options.timeoutMs ?? (
      options.mode === "ack" ? FINALIZATION_ACK_TIMEOUT_MS : LEGACY_FINALIZATION_TIMEOUT_MS
    );
  }

  notifyPartial(utteranceId: string) {
    if (this.settled) return;
    this.pendingUtteranceId = utteranceId;
    this.clearQuietTimer();
  }

  notifyFinal(utteranceId: string) {
    if (this.settled) return;
    if (this.pendingUtteranceId && this.pendingUtteranceId !== utteranceId) return;
    this.pendingUtteranceId = null;
    this.tailFinalSeen = true;
    if (this.started && this.mode === "legacy") this.resolve("tail-final");
  }

  notifyActivity() {
    if (!this.started || this.settled || this.mode !== "legacy" || this.pendingUtteranceId) return;
    this.armQuietTimer();
  }

  notifyFinalized() {
    if (this.settled) return;
    this.acknowledged = true;
    if (this.started && this.mode === "ack") this.resolve("acknowledged");
  }

  fail(error: Error) {
    if (this.settled) return;
    this.failure = error;
    if (this.started) this.reject(error);
  }

  wait(): Promise<FinalizationResult> {
    if (this.waitPromise) return this.waitPromise;
    this.started = true;
    this.waitPromise = new Promise<FinalizationResult>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
    this.timeoutTimer = setTimeout(() => {
      if (this.mode === "ack") {
        this.reject(new Error("GPUから最終確定応答が10秒以内に返りませんでした。セッションは完了していません。"));
      } else {
        this.resolve("timeout");
      }
    }, this.timeoutMs);

    if (this.failure) this.reject(this.failure);
    else if (this.mode === "ack" && this.acknowledged) this.resolve("acknowledged");
    else if (this.mode === "legacy" && this.tailFinalSeen) this.resolve("tail-final");
    else if (this.mode === "legacy" && !this.pendingUtteranceId) this.armQuietTimer();
    return this.waitPromise;
  }

  private armQuietTimer() {
    this.clearQuietTimer();
    this.quietTimer = setTimeout(() => {
      if (!this.pendingUtteranceId) this.resolve("quiet");
    }, this.quietMs);
  }

  private clearQuietTimer() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private clearTimers() {
    this.clearQuietTimer();
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private resolve(result: FinalizationResult) {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.resolveWait?.(result);
  }

  private reject(error: Error) {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.rejectWait?.(error);
  }
}
