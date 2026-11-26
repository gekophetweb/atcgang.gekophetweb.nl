import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

// /photos/<id>/<variant> is handled by the photo route before this; /photos and /photos/me are SPA pages.
const API_PREFIXES = ["/api", "/mcp", "/.well-known", "/healthz"];

/** Serves the built SPA: hashed assets cached forever, everything else falls back to index.html. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serveClient(app: Hono<any>, clientDir: string) {
  const indexPath = path.join(clientDir, "index.html");
  app.use(
    "/assets/*",
    serveStatic({
      root: clientDir,
      onFound: (_p, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
  app.use("*", serveStatic({ root: clientDir }));
  app.get("*", (c) => {
    if (API_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) return c.notFound();
    if (!existsSync(indexPath)) return c.text("Client not built", 404);
    c.header("Cache-Control", "no-cache");
    return c.html(readFileSync(indexPath, "utf8"));
  });
}
