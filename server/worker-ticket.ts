import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkerRuntime } from "./types.js";

export const WORKER_TICKET_AUDIENCE = "qwen-realtime-worker";

export interface WorkerTicketClaims {
  v: 1;
  aud: typeof WORKER_TICKET_AUDIENCE;
  wid: string;
  sid: string;
  mid: string;
  purpose: WorkerRuntime;
  exp: number;
}

function signature(secret: string, encodedPayload: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function createWorkerTicket(input: {
  secret: string;
  workerId: string;
  sessionId: string;
  modelId: string;
  purpose: WorkerRuntime;
  nowMs?: number;
  ttlSeconds: number;
}) {
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: WorkerTicketClaims = {
    v: 1,
    aud: WORKER_TICKET_AUDIENCE,
    wid: input.workerId,
    sid: input.sessionId,
    mid: input.modelId,
    purpose: input.purpose,
    exp: issuedAt + input.ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return { token: `${payload}.${signature(input.secret, payload)}`, claims };
}

export function verifyWorkerTicket(token: string, secret: string, nowMs = Date.now()): WorkerTicketClaims | null {
  const [payload, receivedSignature, extra] = token.split(".");
  if (!payload || !receivedSignature || extra || !safeEqual(receivedSignature, signature(secret, payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<WorkerTicketClaims>;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (
      claims.v !== 1
      || claims.aud !== WORKER_TICKET_AUDIENCE
      || typeof claims.wid !== "string"
      || typeof claims.sid !== "string"
      || typeof claims.mid !== "string"
      || (claims.purpose !== "realtime" && claims.purpose !== "batch")
      || typeof claims.exp !== "number"
      || !Number.isInteger(claims.exp)
      || claims.exp <= nowSeconds
    ) return null;
    return claims as WorkerTicketClaims;
  } catch {
    return null;
  }
}
