import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import type { AppDeps } from "../app.js";
import { currentUser, requireUser, type Env } from "../context.js";
import { mcpResource } from "../auth.js";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, users } from "../db/schema.js";
import { buildMcpServer } from "./server.js";

/**
 * /mcp – Streamable HTTP MCP endpoint, protected by OAuth access tokens issued by this app.
 * Tokens are verified (signature, issuer, audience = /mcp); the tools then act as the token's user.
 */
export function mcpRoutes(deps: AppDeps) {
  const { db, auth, config } = deps;
  const r = new Hono<Env>();

  const handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { userId: string; name: string };
      return buildMcpServer(deps, { id: extra.userId, name: extra.name });
    },
    { legacy: "stateless", onerror: (e) => console.error("[mcp]", e) },
  );

  const protectedHandler = requireMcpAuth(
    auth,
    async (req, claims) => {
      const userId = String(claims.sub);
      const clientId = String(claims.azp);
      const [u] = await db.select({ name: users.name, email: users.email, disabled: users.disabled }).from(users).where(eq(users.id, userId));
      // Revoking a connection in Settings removes the consent; refuse tokens issued before that.
      const [consent] = await db
        .select({ id: oauthConsent.id })
        .from(oauthConsent)
        .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
        .limit(1);
      if (!u || u.disabled || !consent) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
        });
      }
      const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
      return handler.fetch(req, { authInfo: { token: "", clientId, scopes, extra: { userId, name: u.name || u.email } } });
    },
    { resource: mcpResource(config) },
  );

  r.on(["POST", "GET", "DELETE"], "/mcp", (c) => protectedHandler(c.req.raw));

  // Settings: list and revoke connected MCP clients.
  r.get("/api/mcp-connections", requireUser, async (c) => {
    const rows = await db
      .select({ id: oauthConsent.id, clientId: oauthConsent.clientId, scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt, name: oauthClient.name, uri: oauthClient.uri })
      .from(oauthConsent)
      .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .where(eq(oauthConsent.userId, currentUser(c).id))
      .orderBy(desc(oauthConsent.createdAt));
    return c.json(rows.map((r) => ({ id: r.id, clientName: r.name || r.uri || r.clientId, scopes: r.scopes, createdAt: r.createdAt })));
  });
  r.delete("/api/mcp-connections/:id", requireUser, async (c) => {
    const userId = currentUser(c).id;
    const [consent] = await db
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.id, c.req.param("id")), eq(oauthConsent.userId, userId)));
    if (!consent) return c.json({ error: "Not found" }, 404);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(oauthConsent).where(eq(oauthConsent.id, consent.id));
      await tx
        .update(oauthRefreshToken)
        .set({ revoked: now })
        .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, consent.clientId), isNull(oauthRefreshToken.revoked)));
      await tx
        .update(oauthAccessToken)
        .set({ revoked: now })
        .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, consent.clientId), isNull(oauthAccessToken.revoked)));
    });
    return c.body(null, 204);
  });

  return r;
}
