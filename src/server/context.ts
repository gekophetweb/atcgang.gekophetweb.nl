import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "./auth.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: "user" | "admin";
  emailNotifications: boolean;
  disabled: boolean;
}

export type Env = { Variables: { user: SessionUser | null } };

export function sessionMiddleware(auth: Auth) {
  return createMiddleware<Env>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = (session?.user as SessionUser | undefined) ?? null;
    c.set("user", user && !user.disabled ? user : null);
    await next();
  });
}

export const requireUser = createMiddleware<Env>(async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "Sign in required" });
  await next();
});

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  if (c.get("user")?.role !== "admin") throw new HTTPException(403, { message: "Admins only" });
  await next();
});

export function currentUser(c: Context<Env>): SessionUser {
  const u = c.get("user");
  if (!u) throw new HTTPException(401, { message: "Sign in required" });
  return u;
}
