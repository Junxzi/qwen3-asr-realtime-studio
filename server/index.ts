import "dotenv/config";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTranscriptionStore } from "./postgres-store.js";
import { createProvider } from "./runpod.js";
import { runRetentionMaintenance } from "./transcriptions.js";
import { createWorkerScheduler } from "./worker-scheduler.js";
import { createWorkerPoolStore } from "./worker-store.js";

const config = loadConfig();
const provider = createProvider(config);
const store = createTranscriptionStore(config);
const workerStore = createWorkerPoolStore(config);
const scheduler = createWorkerScheduler(config, provider, { store: workerStore });
const app = createApp(config, provider, { store, scheduler });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", port: config.port, provider: config.provider }));
});

async function maintain() {
  try {
    const [result, releasedAssignments] = await Promise.all([
      runRetentionMaintenance(store, config, new Date(), (sessionId) => scheduler.release(sessionId)),
      scheduler.reapExpired(),
    ]);
    if (result.expired || result.stale || releasedAssignments) {
      console.log(JSON.stringify({ level: "info", event: "transcription_maintenance", ...result, releasedAssignments }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "transcription_maintenance_failed",
      message: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

void maintain();
const maintenanceTimer = setInterval(() => { void maintain(); }, 86_400_000);
maintenanceTimer.unref();
const reconcileTimer = setInterval(() => {
  void scheduler.reconcile().catch((error) => {
    console.error(JSON.stringify({ level: "error", event: "worker_reconcile_failed", message: error instanceof Error ? error.message : "unknown error" }));
  });
}, config.workerReconcileIntervalMs);
reconcileTimer.unref();
const reaperTimer = setInterval(() => {
  void scheduler.reapExpired().catch((error) => {
    console.error(JSON.stringify({ level: "error", event: "worker_reaper_failed", message: error instanceof Error ? error.message : "unknown error" }));
  });
}, config.workerReaperIntervalMs);
reaperTimer.unref();
void scheduler.reconcile().catch((error) => {
  console.error(JSON.stringify({ level: "error", event: "worker_reconcile_failed", message: error instanceof Error ? error.message : "unknown error" }));
});

async function shutdown(signal: string) {
  clearInterval(maintenanceTimer);
  clearInterval(reconcileTimer);
  clearInterval(reaperTimer);
  server.close(async () => {
    await Promise.all([store.close(), scheduler.close()]);
    console.log(JSON.stringify({ level: "info", event: "server_stopped", signal }));
    process.exit(0);
  });
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
