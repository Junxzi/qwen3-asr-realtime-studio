import { useCallback, useEffect, useRef } from "react";
import { api, ApiError } from "./api";
import type { AssignmentPurpose, ProcessingProfile } from "./types";

export const ASSIGNMENT_HEARTBEAT_INTERVAL_MS = 60_000;

type HeartbeatProfile = Pick<ProcessingProfile, "id" | "assignments">;
type HeartbeatSender = (
  sessionId: string,
  purpose: AssignmentPurpose,
  signal: AbortSignal,
) => Promise<unknown>;

function isLostLease(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function useAssignmentHeartbeat(
  onLeaseLost?: (error: Error, sessionId: string) => void,
  sender: HeartbeatSender = api.heartbeatAssignment,
  intervalMs = ASSIGNMENT_HEARTBEAT_INTERVAL_MS,
) {
  const senderRef = useRef(sender);
  const onLeaseLostRef = useRef(onLeaseLost);
  const timerRef = useRef<number | null>(null);
  const controllersRef = useRef(new Map<AssignmentPurpose, AbortController>());
  const sessionIdRef = useRef<string | null>(null);
  const planKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  senderRef.current = sender;
  onLeaseLostRef.current = onLeaseLost;

  const stop = useCallback((expectedSessionId?: string) => {
    if (expectedSessionId && sessionIdRef.current !== expectedSessionId) return;
    generationRef.current += 1;
    sessionIdRef.current = null;
    planKeyRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  const start = useCallback((sessionId: string, profile: HeartbeatProfile) => {
    const purposes = [...new Set(profile.assignments.map(({ purpose }) => purpose))].sort();
    const planKey = `${profile.id}:${purposes.join(",")}`;
    if (
      sessionIdRef.current === sessionId
      && planKeyRef.current === planKey
      && timerRef.current !== null
    ) return;

    stop();
    if (!purposes.length) return;
    sessionIdRef.current = sessionId;
    planKeyRef.current = planKey;
    const generation = generationRef.current;

    const heartbeat = async (purpose: AssignmentPurpose) => {
      if (
        generationRef.current !== generation
        || sessionIdRef.current !== sessionId
        || controllersRef.current.has(purpose)
      ) return;

      const controller = new AbortController();
      controllersRef.current.set(purpose, controller);
      try {
        await senderRef.current(sessionId, purpose, controller.signal);
      } catch (error) {
        const stopped = generationRef.current !== generation || sessionIdRef.current !== sessionId;
        const fatalLeaseLoss = isLostLease(error)
          && (profile.id !== "hybrid" || purpose === "realtime");
        if (!stopped && !isAbortError(error) && fatalLeaseLoss) {
          stop(sessionId);
          onLeaseLostRef.current?.(error, sessionId);
        }
        // Network/server failures, and a hybrid finalizer that is not ready
        // yet, remain retryable. Realtime lease loss is always fatal.
      } finally {
        if (controllersRef.current.get(purpose) === controller) {
          controllersRef.current.delete(purpose);
        }
      }
    };

    const tick = () => {
      for (const purpose of purposes) void heartbeat(purpose);
    };
    timerRef.current = window.setInterval(tick, intervalMs);
    tick();
  }, [intervalMs, stop]);

  useEffect(() => stop, [stop]);

  return { start, stop };
}
