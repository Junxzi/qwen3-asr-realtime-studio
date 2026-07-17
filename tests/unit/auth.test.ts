import { describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, verifySessionToken } from "../../server/auth.js";

describe("session authentication", () => {
  it("signs and verifies an unexpired token", () => {
    const token = createSessionToken("a-strong-test-session-secret", 1_000_000, 60);
    expect(verifySessionToken(token, "a-strong-test-session-secret", 1_030_000)).toBe(true);
    expect(verifySessionToken(token, "a-strong-test-session-secret", 1_061_000)).toBe(false);
    expect(verifySessionToken(`${token}x`, "a-strong-test-session-secret", 1_030_000)).toBe(false);
  });

  it("compares control passwords without accepting different values", () => {
    expect(passwordMatches("correct horse", "correct horse")).toBe(true);
    expect(passwordMatches("correct horse", "wrong horse")).toBe(false);
  });
});

