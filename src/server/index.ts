import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./app.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db, sql } = createDb(config.DATABASE_URL);
const app = createApp({ config, db });

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`web listening on :${info.port}`);
});

async function shutdown() {
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
