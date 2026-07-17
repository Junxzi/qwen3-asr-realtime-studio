import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config.js";

describe("configuration", () => {
  it("uses safe mock defaults for local development", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.provider).toBe("mock");
    expect(config.podId).toBe("nhf73n5jvajgyj");
    expect(config.readyPath).toBe("/health");
  });

  it("refuses live mode without secrets", () => {
    expect(() => loadConfig({ NODE_ENV: "production", RUNPOD_PROVIDER: "live" })).toThrow("RUNPOD_API_KEY");
  });

  it("allows read-only service probing without an API key", () => {
    const config = loadConfig({ NODE_ENV: "production", RUNPOD_PROVIDER: "readonly" });
    expect(config.provider).toBe("readonly");
    expect(config.apiKey).toBe("");
  });

  it("uses memory history locally and requires a URL for an explicit Postgres store", () => {
    expect(loadConfig({ NODE_ENV: "test" }).transcriptStorage).toBe("memory");
    expect(() => loadConfig({ NODE_ENV: "test", TRANSCRIPT_STORAGE: "postgres" })).toThrow("DATABASE_URL");
    expect(loadConfig({
      NODE_ENV: "test",
      TRANSCRIPT_STORAGE: "postgres",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/asr",
    }).transcriptStorage).toBe("postgres");
  });
});
