import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import type { Config } from "./config.js";
import { serveClient } from "./static.js";

export interface AppDeps {
  config: Config;
  db: Db;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  serveClient(app, deps.config.CLIENT_DIR);
  return app;
}
