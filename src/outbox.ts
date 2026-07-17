import type { PersistUtteranceInput } from "./types";

const DATABASE_NAME = "infodeliver-asr-studio";
const STORE_NAME = "transcription-outbox";
const VERSION = 1;

export interface OutboxItem {
  key: string;
  sessionId: string;
  utteranceId: string;
  payload: PersistUtteranceInput;
  createdAt: string;
}

function supportsIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDBを開けません"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  if (!supportsIndexedDb()) return undefined;
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB操作に失敗しました"));
    });
  } finally {
    database.close();
  }
}

export function outboxKey(sessionId: string, utteranceId: string) {
  return `${sessionId}:${utteranceId}`;
}

export async function enqueueOutbox(sessionId: string, utteranceId: string, payload: PersistUtteranceInput) {
  const item: OutboxItem = {
    key: outboxKey(sessionId, utteranceId),
    sessionId,
    utteranceId,
    payload,
    createdAt: new Date().toISOString(),
  };
  await withStore("readwrite", (store) => store.put(item));
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const result = await withStore("readonly", (store) => store.getAll());
  return (result || []) as OutboxItem[];
}

export async function removeOutbox(key: string) {
  await withStore("readwrite", (store) => store.delete(key));
}

export async function removeSessionOutbox(sessionId: string) {
  const items = await listOutbox();
  await Promise.all(items.filter((item) => item.sessionId === sessionId).map((item) => removeOutbox(item.key)));
}

export async function flushOutbox(save: (item: OutboxItem) => Promise<unknown>) {
  const items = await listOutbox();
  let saved = 0;
  for (const item of items) {
    try {
      await save(item);
      await removeOutbox(item.key);
      saved += 1;
    } catch {
      // Keep the remaining item for the next online/authenticated retry.
    }
  }
  return { pending: Math.max(0, items.length - saved), saved };
}
