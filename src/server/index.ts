import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createServices } from "./services.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const services = await createServices(config);

const server = serve({ fetch: services.app.fetch, port: config.PORT }, (info) => {
  console.log(`web listening on :${info.port} (sso: ${services.providers.join(", ") || "none"})`);
});

// Apple's client secret is minted at startup and valid for 180 days: restart (Docker brings us back) before that.
// (setTimeout can't take delays over ~24.8 days, so check once a day.)
const startedAt = Date.now();
const RESTART_AFTER_MS = 150 * 24 * 3600 * 1000;
setInterval(() => {
  if (Date.now() - startedAt > RESTART_AFTER_MS) void shutdown("apple secret rotation");
}, 24 * 3600 * 1000).unref();

async function shutdown(reason: string) {
  console.log(`shutting down: ${reason}`);
  server.close();
  await services.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
