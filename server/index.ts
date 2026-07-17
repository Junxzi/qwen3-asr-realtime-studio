import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTranscriptionStore } from "./postgres-store.js";
import { createProvider } from "./runpod.js";
import { runRetentionMaintenance } from "./transcriptions.js";

const config = loadConfig();
const provider = createProvider(config);
const store = createTranscriptionStore(config);
const app = createApp(config, provider, { store });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", port: config.port, provider: config.provider }));
});

async function maintain() {
  try {
    const result = await runRetentionMaintenance(store, config);
    if (result.expired || result.stale) {
      console.log(JSON.stringify({ level: "info", event: "transcription_maintenance", ...result }));
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

async function shutdown(signal: string) {
  clearInterval(maintenanceTimer);
  server.close(async () => {
    await store.close();
    console.log(JSON.stringify({ level: "info", event: "server_stopped", signal }));
    process.exit(0);
  });
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
