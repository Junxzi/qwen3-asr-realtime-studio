import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { AppConfig } from "./config.js";

export const SESSION_COOKIE = "qwen_control_session";

function equal(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function passwordMatches(candidate: string, expected: string) {
  return equal(candidate, expected);
}

export function createSessionToken(secret: string, nowMs: number, ttlSeconds: number) {
  const payload = `${Math.floor(nowMs / 1000)}.${Math.floor(nowMs / 1000) + ttlSeconds}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined, secret: string, nowMs = Date.now()) {
  if (!token) return false;
  const [issued, expires, signature, extra] = token.split(".");
  if (!issued || !expires || !signature || extra) return false;
  const payload = `${issued}.${expires}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const expiresAt = Number(expires);
  return Number.isFinite(expiresAt) && expiresAt >= Math.floor(nowMs / 1000) && equal(signature, expected);
}

export function setSessionCookie(response: Response, config: AppConfig, nowMs = Date.now()) {
  response.cookie(SESSION_COOKIE, createSessionToken(config.sessionSecret, nowMs, config.sessionTtlSeconds), {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    maxAge: config.sessionTtlSeconds * 1000,
    path: "/",
  });
}

export function clearSessionCookie(response: Response, config: AppConfig) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
  });
}

export function requireAuth(config: AppConfig, now: () => number = Date.now) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!verifySessionToken(request.cookies?.[SESSION_COOKIE], config.sessionSecret, now())) {
      response.status(401).json({
        error: { code: "authentication_required", message: "操作セッションへログインしてください", requestId: response.locals.requestId },
      });
      return;
    }
    next();
  };
}

export function requireAllowedOrigin(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.get("origin");
    if (!origin) return next();
    const expected = config.allowedOrigin || `${request.protocol}://${request.get("host")}`;
    if (origin.replace(/\/$/, "") !== expected) {
      response.status(403).json({
        error: { code: "origin_not_allowed", message: "この画面からの操作だけが許可されています", requestId: response.locals.requestId },
      });
      return;
    }
    next();
  };
}
