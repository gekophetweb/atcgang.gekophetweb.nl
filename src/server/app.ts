import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "./db/client.js";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import type { Mailer } from "./lib/mailer.js";
import { serveClient } from "./static.js";
import { requireUser, sessionMiddleware, type Env } from "./context.js";

export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  providers: string[];
}

export function createApp(deps: AppDeps) {
  const { config, db, auth } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: "Invalid input", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/healthz", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", sessionMiddleware(auth));

  app.get("/api/config", (c) =>
    c.json({ providers: deps.providers, turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null }),
  );

  app.get("/api/me", requireUser, (c) => c.json({ user: c.get("user") }));

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  serveClient(app, config.CLIENT_DIR);
  return app;
}
