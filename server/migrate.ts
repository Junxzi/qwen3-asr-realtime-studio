import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { loadConfig } from "./config.js";

const config = loadConfig();

if (config.transcriptStorage !== "postgres") {
  console.log(JSON.stringify({ level: "info", event: "migration_skipped", storage: config.transcriptStorage }));
} else {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    ssl: config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: false },
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    console.log(JSON.stringify({ level: "info", event: "migration_completed" }));
  } finally {
    await pool.end();
  }
}
