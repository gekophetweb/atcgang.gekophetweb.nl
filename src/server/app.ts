import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "./db/client.js";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import type { Mailer } from "./lib/mailer.js";
import type { Storage } from "./lib/storage.js";
import type { Jobs } from "./lib/jobs.js";
import type { AppNotifier } from "./domain/notifications.js";
import type { SettingsStore } from "./settings.js";
import { photoApiRoutes, photoFileRoutes } from "./routes/photos.js";
import { mcpRoutes } from "./mcp/route.js";
import { accountRoutes } from "./routes/account.js";
import { concertRoutes } from "./routes/concerts.js";
import { peopleRoutes } from "./routes/people.js";
import { serveClient } from "./static.js";
import { requireUser, sessionMiddleware, type Env } from "./context.js";

export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  providers: () => string[];
  settings: SettingsStore;
  storage: Storage;
  jobs: Jobs;
  notify: AppNotifier;
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
  // OAuth discovery for MCP clients (authorization server + protected resource metadata).
  app.on(["GET", "HEAD"], "/.well-known/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", sessionMiddleware(auth));
  app.route("/", mcpRoutes(deps));

  app.get("/api/config", (c) =>
    c.json({ providers: deps.providers(), turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null }),
  );

  app.get("/api/me", requireUser, (c) => c.json({ user: c.get("user") }));

  app.use("/api/*", async (c, next) => {
    // Everything below needs a session, except the invite preview.
    if (c.req.method === "GET" && /^\/api\/invites\/[^/]+$/.test(c.req.path)) return next();
    return requireUser(c, next);
  });
  app.route("/api", concertRoutes(deps));
  app.route("/api", peopleRoutes(deps));
  app.route("/api", photoApiRoutes(deps));
  app.route("/api", accountRoutes(deps));

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  app.route("/", photoFileRoutes(deps));

  serveClient(app, config.CLIENT_DIR);
  return app;
}
