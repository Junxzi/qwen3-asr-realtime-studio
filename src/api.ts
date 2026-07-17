import type {
  AsrModelCatalog,
  AssignmentPurpose,
  ControlStatus,
  InferenceAssignment,
  PersistUtteranceInput,
  ProcessingMode,
  TranscriptSource,
  TranscriptUtterance,
  TranscriptionDetail,
  TranscriptionList,
  TranscriptionMetrics,
  TranscriptionSession,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code || "request_failed",
      payload?.error?.message || `HTTP ${response.status}`,
      payload?.error?.requestId,
    );
  }
  return payload.data as T;
}

async function requestEnvelope<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code || "request_failed",
      payload?.error?.message || `HTTP ${response.status}`,
      payload?.error?.requestId,
    );
  }
  return payload as { data: T; meta?: TranscriptionList["meta"] };
}

export const api = {
  session: () => request<{ authenticated: true }>("/api/session"),
  login: (password: string) => request<{ authenticated: true }>("/api/session/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  }),
  logout: () => request<{ authenticated: false }>("/api/session/logout", { method: "POST", body: "{}" }),
  status: () => request<ControlStatus>("/api/control/status"),
  models: () => request<AsrModelCatalog>("/api/models"),
  start: () => request<{ operationId: string; stage: "starting" }>("/api/control/start", { method: "POST", body: "{}" }),
  stop: () => request<{ operationId: string; stage: "stopping" }>("/api/control/stop", { method: "POST", body: "{}" }),
  transcriptions: async (parameters: { q?: string; cursor?: string; limit?: number } = {}): Promise<TranscriptionList> => {
    const query = new URLSearchParams();
    if (parameters.q) query.set("q", parameters.q);
    if (parameters.cursor) query.set("cursor", parameters.cursor);
    query.set("limit", String(parameters.limit || 50));
    const payload = await requestEnvelope<TranscriptionSession[]>(`/api/transcriptions?${query}`);
    return {
      items: payload.data,
      meta: payload.meta || { totalCount: payload.data.length, pageSize: parameters.limit || 50, nextCursor: null },
    };
  },
  createTranscription: (input: {
    source: TranscriptSource;
    processing_mode: ProcessingMode;
    model_id?: string;
    final_model_id?: string | null;
    catalog_revision: string;
  }) => request<TranscriptionSession>("/api/transcriptions", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  requestAssignment: (id: string, purpose: AssignmentPurpose, signal?: AbortSignal) =>
    request<InferenceAssignment>(`/api/transcriptions/${encodeURIComponent(id)}/assignment`, {
      method: "POST",
      body: JSON.stringify({ purpose }),
      signal,
    }),
  assignment: (id: string, purpose?: AssignmentPurpose, signal?: AbortSignal) => {
    const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : "";
    return request<InferenceAssignment>(`/api/transcriptions/${encodeURIComponent(id)}/assignment${query}`, { signal });
  },
  heartbeatAssignment: (id: string, purpose?: AssignmentPurpose, signal?: AbortSignal) =>
    request<{
      status: "active";
      lease_expires_at: string;
      assignments?: Array<{
        purpose: AssignmentPurpose;
        status: "active";
        lease_expires_at: string;
      }>;
    }>(
      `/api/transcriptions/${encodeURIComponent(id)}/assignment/heartbeat`,
      { method: "POST", body: JSON.stringify(purpose ? { purpose } : {}), signal },
    ),
  transcription: (id: string) => request<TranscriptionDetail>(`/api/transcriptions/${encodeURIComponent(id)}`),
  renameTranscription: (id: string, title: string) => request<TranscriptionSession>(`/api/transcriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  }),
  saveUtterance: (sessionId: string, utteranceId: string, input: PersistUtteranceInput, signal?: AbortSignal) =>
    request<TranscriptUtterance>(`/api/transcriptions/${encodeURIComponent(sessionId)}/utterances/${encodeURIComponent(utteranceId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
      signal,
    }),
  completeTranscription: (
    id: string,
    input: { status: "completed" | "interrupted" | "failed"; duration_ms: number | null; metrics: TranscriptionMetrics },
  ) => request<TranscriptionSession>(`/api/transcriptions/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  deleteTranscription: (id: string) => request<{ deleted: true }>(`/api/transcriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  }),
};
