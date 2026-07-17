import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api";
import {
  enqueueOutbox,
  flushOutbox,
  listOutbox,
  OUTBOX_RETENTION_MS,
  outboxKey,
  outboxItemExpired,
  removeOutbox,
  terminalOutboxFailure,
  type OutboxItem,
} from "../../src/outbox";
import type { PersistUtteranceInput } from "../../src/types";

function successfulRequest<T>(operation: () => T): IDBRequest<T> {
  const request = {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  } as unknown as IDBRequest<T>;
  queueMicrotask(() => {
    try {
      Object.defineProperty(request, "result", { configurable: true, value: operation() });
      request.onsuccess?.call(request, {} as Event);
    } catch (error) {
      Object.defineProperty(request, "error", { configurable: true, value: error });
      request.onerror?.call(request, {} as Event);
    }
  });
  return request;
}

function installMemoryIndexedDb() {
  const records = new Map<string, OutboxItem>();
  let storeCreated = false;
  const objectStore = {
    put(value: OutboxItem) {
      return successfulRequest(() => {
        records.set(value.key, value);
        return value.key;
      });
    },
    getAll() {
      return successfulRequest(() => [...records.values()]);
    },
    delete(key: IDBValidKey) {
      return successfulRequest(() => {
        records.delete(String(key));
        return undefined;
      });
    },
  } as unknown as IDBObjectStore;
  const database = {
    objectStoreNames: { contains: () => storeCreated },
    createObjectStore: () => {
      storeCreated = true;
      return objectStore;
    },
    transaction: () => ({ objectStore: () => objectStore }),
    close: () => undefined,
  } as unknown as IDBDatabase;
  const factory = {
    open: () => {
      const request = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (!storeCreated) request.onupgradeneeded?.call(request, {} as IDBVersionChangeEvent);
        request.onsuccess?.call(request, {} as Event);
      });
      return request;
    },
  } as unknown as IDBFactory;
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  return {
    records,
    restore: () => {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function payload(revision: number): PersistUtteranceInput {
  return {
    revision,
    text: `revision-${revision}`,
    words: [],
    context_hits: [],
    audio_end_ms: revision * 100,
    latency_ms: null,
    queue_ms: null,
    rtf: null,
  };
}

function item(createdAt: string): OutboxItem {
  return {
    key: outboxKey("session", "utterance", 0),
    sessionId: "session",
    utteranceId: "utterance",
    payload: payload(0),
    createdAt,
  };
}

let memoryIndexedDb: ReturnType<typeof installMemoryIndexedDb> | undefined;

beforeEach(() => {
  memoryIndexedDb = installMemoryIndexedDb();
});

afterEach(() => {
  memoryIndexedDb?.restore();
  memoryIndexedDb = undefined;
});

describe("transcription outbox retention", () => {
  it("expires records after the same 30-day window as server history", () => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    expect(outboxItemExpired(item(new Date(now - OUTBOX_RETENTION_MS + 1).toISOString()), now)).toBe(false);
    expect(outboxItemExpired(item(new Date(now - OUTBOX_RETENTION_MS).toISOString()), now)).toBe(true);
    expect(outboxItemExpired(item("invalid"), now)).toBe(true);
  });

  it("discards only terminal missing-history failures", () => {
    expect(terminalOutboxFailure(new ApiError(404, "not_found", "missing"))).toBe(true);
    expect(terminalOutboxFailure(new ApiError(410, "gone", "gone"))).toBe(true);
    expect(terminalOutboxFailure(new ApiError(503, "unavailable", "retry"))).toBe(false);
    expect(terminalOutboxFailure(new TypeError("network"))).toBe(false);
  });
});

describe("transcription outbox revisions", () => {
  it("uses a distinct key for every revision while preserving the utterance cleanup key", () => {
    expect(outboxKey("session", "utterance")).toBe("session:utterance");
    expect(outboxKey("session", "utterance", 1)).toBe("session:utterance::revision::1");
    expect(outboxKey("session", "utterance", 2)).not.toBe(outboxKey("session", "utterance", 1));
  });

  it("does not let an old in-flight flush delete a newer enqueued revision", async () => {
    await enqueueOutbox("session", "utterance", payload(1));
    const saveStarted = deferred();
    const releaseSave = deferred();

    const flushing = flushOutbox(async (queued) => {
      expect(queued.payload.revision).toBe(1);
      saveStarted.resolve();
      await releaseSave.promise;
    });
    await saveStarted.promise;
    await enqueueOutbox("session", "utterance", payload(2));
    releaseSave.resolve();

    await expect(flushing).resolves.toEqual({ saved: 1, discarded: 0, pending: 1 });
    const remaining = await listOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      key: outboxKey("session", "utterance", 2),
      payload: { revision: 2 },
    });
  });

  it("keeps legacy key deletion exact and supports exact revision cleanup", async () => {
    const legacy = item(new Date().toISOString());
    legacy.key = outboxKey("session", "legacy-utterance");
    legacy.utteranceId = "legacy-utterance";
    memoryIndexedDb?.records.set(legacy.key, legacy);
    await enqueueOutbox("session", "utterance", payload(1));
    await enqueueOutbox("session", "utterance", payload(2));

    await removeOutbox(outboxKey("session", "legacy-utterance"));
    expect((await listOutbox()).some((queued) => queued.utteranceId === "legacy-utterance")).toBe(false);

    await removeOutbox(outboxKey("session", "utterance", 1));
    expect((await listOutbox()).map((queued) => queued.payload.revision)).toEqual([2]);

    // Existing two-argument callers still compile and can delete persisted
    // legacy records, but cannot accidentally delete a revision-keyed item.
    await removeOutbox(outboxKey("session", "utterance"));
    expect((await listOutbox()).map((queued) => queued.payload.revision)).toEqual([2]);

    await removeOutbox(outboxKey("session", "utterance", 2));
    expect(await listOutbox()).toEqual([]);
  });
});
