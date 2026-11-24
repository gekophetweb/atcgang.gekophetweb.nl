import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createServices } from "./services.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const services = await createServices(config);
await services.jobs.start();

const server = serve({ fetch: services.app.fetch, port: config.PORT }, (info) => {
  console.log(`web listening on :${info.port} (sso: ${services.providers().join(", ") || "none"})`);
});

// Rebuild auth daily so the Apple client secret (valid 180 days) is always fresh.
setInterval(() => void services.rebuildAuth(), 24 * 3600 * 1000).unref();

async function shutdown(reason: string) {
  console.log(`shutting down: ${reason}`);
  server.close();
  await services.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
