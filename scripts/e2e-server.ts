// Starts a throwaway Postgres (Testcontainers) and the built app on :3100 for Playwright.
// Mail goes to e2e/.outbox.jsonl so tests can read login codes.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { serve } from "@hono/node-server";
import { loadConfig } from "../src/server/config.js";
import { runMigrations } from "../src/server/db/migrate.js";
import { createServices } from "../src/server/services.js";

const port = Number(process.env.E2E_PORT ?? 3100);
const outbox = path.resolve("e2e/.outbox.jsonl");
writeFileSync(outbox, "");
const pg = await new PostgreSqlContainer("postgres:17-alpine").start();
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: pg.getConnectionUri(),
  BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
  BASE_URL: `http://localhost:${port}`,
  CLIENT_DIR: "./dist/client",
  PHOTO_DIR: mkdtempSync(path.join(tmpdir(), "atc-e2e-")),
  MAIL_OUTBOX_FILE: outbox,
  TRUST_CF_HEADERS: "false",
});
await runMigrations(config.DATABASE_URL);
const services = await createServices(config);
await services.jobs.start();
serve({ fetch: services.app.fetch, port }, () => console.log(`e2e server on http://localhost:${port}`));

const stop = async () => {
  await services.close();
  await pg.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
