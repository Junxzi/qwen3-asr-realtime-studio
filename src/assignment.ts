import type { AssignmentConnection, AssignmentPurpose, InferenceAssignment } from "./types";

const MIN_POLL_DELAY_MS = 500;
const MAX_POLL_DELAY_MS = 5_000;

export function assignmentPollDelay(assignment: InferenceAssignment) {
  const requested = Number(assignment.retry_after_ms);
  if (!Number.isFinite(requested)) return 1_500;
  return Math.min(MAX_POLL_DELAY_MS, Math.max(MIN_POLL_DELAY_MS, Math.round(requested)));
}

export function assignmentIsReady(assignment: InferenceAssignment) {
  return assignment.status === "ready" || assignment.status === "active";
}

export function assertAssignmentMatches(
  assignment: InferenceAssignment,
  session: { id: string; model_id: string },
) {
  if (assignment.session_id !== session.id) throw new Error("GPUの割り当て先セッションが一致しません");
  if (assignment.model_id !== session.model_id) throw new Error("GPUの割り当てモデルが一致しません");
}

export function assignmentMessage(assignment: InferenceAssignment, modelName?: string) {
  if (assignment.message) return assignment.message;
  switch (assignment.status) {
    case "requested":
      return "利用可能なGPUを探しています";
    case "provisioning":
      return assignment.worker && assignment.worker.loaded_model_id !== assignment.model_id
        ? `${modelName || "モデル"}を読み込んでいます`
        : "GPUを準備しています";
    case "ready":
      return "GPUとモデルの準備ができました";
    case "active":
      return "割り当て済みGPUで処理しています";
    case "released":
      return "GPUの割り当てを解放しました";
    case "failed":
      return "現在、利用できるGPU容量がありません";
  }
}

export function requireAssignmentConnection(
  assignment: InferenceAssignment,
  purpose: AssignmentPurpose,
): AssignmentConnection {
  if (!assignmentIsReady(assignment)) throw new Error("GPUの割り当てがまだ準備できていません");
  if (assignment.purpose !== purpose) throw new Error("GPUの割り当てと処理方式が一致しません");
  const connection = assignment.connection;
  if (!connection?.ticket) throw new Error("GPU接続チケットを取得できませんでした");
  if (purpose === "realtime" && !connection.websocket_url) {
    throw new Error("リアルタイム接続先を取得できませんでした");
  }
  if (purpose === "batch" && !connection.batch_url) {
    throw new Error("ファイル文字起こしの接続先を取得できませんでした");
  }
  return connection;
}

export function waitForAssignmentPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("割り当て待機を中止しました", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("割り当て待機を中止しました", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
