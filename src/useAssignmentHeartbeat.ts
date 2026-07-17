import { useCallback, useEffect, useRef } from "react";
import { api, ApiError } from "./api";

export const ASSIGNMENT_HEARTBEAT_INTERVAL_MS = 60_000;

type HeartbeatSender = (sessionId: string, signal: AbortSignal) => Promise<unknown>;

export function useAssignmentHeartbeat(
  onLeaseLost?: (error: Error, sessionId: string) => void,
  sender: HeartbeatSender = api.heartbeatAssignment,
  intervalMs = ASSIGNMENT_HEARTBEAT_INTERVAL_MS,
) {
  const senderRef = useRef(sender);
  const onLeaseLostRef = useRef(onLeaseLost);
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  senderRef.current = sender;
  onLeaseLostRef.current = onLeaseLost;

  const stop = useCallback((expectedSessionId?: string) => {
    if (expectedSessionId && sessionIdRef.current !== expectedSessionId) return;
    generationRef.current += 1;
    sessionIdRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const start = useCallback((sessionId: string) => {
    if (sessionIdRef.current === sessionId && timerRef.current !== null) return;
    stop();
    sessionIdRef.current = sessionId;
    const generation = generationRef.current;

    const heartbeat = async () => {
      if (
        generationRef.current !== generation
        || sessionIdRef.current !== sessionId
        || controllerRef.current
      ) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        await senderRef.current(sessionId, controller.signal);
      } catch (error) {
        const stopped = generationRef.current !== generation
          || sessionIdRef.current !== sessionId;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!stopped && !aborted && error instanceof ApiError && [404, 409].includes(error.status)) {
          stop(sessionId);
          onLeaseLostRef.current?.(error, sessionId);
        }
        // Transient network/server failures are retried on the next tick. The
        // server lease remains fail-safe and eventually releases capacity.
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    };

    void heartbeat();
    timerRef.current = window.setInterval(() => { void heartbeat(); }, intervalMs);
  }, [intervalMs, stop]);

  useEffect(() => stop, [stop]);

  return { start, stop };
}
