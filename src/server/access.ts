import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Db } from "./db/client.js";
import { concertMembers } from "./db/schema.js";

export type Role = "owner" | "editor" | "viewer";
const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export async function concertRole(db: Db, userId: string, concertId: string): Promise<Role | null> {
  if (!isUuid(concertId)) return null;
  const [m] = await db
    .select({ role: concertMembers.role })
    .from(concertMembers)
    .where(and(eq(concertMembers.concertId, concertId), eq(concertMembers.userId, userId)));
  return m?.role ?? null;
}

/**
 * The one access check every concert-scoped handler goes through.
 * No membership → 404 (don't reveal the concert exists); too low a role → 403.
 */
export async function requireConcertRole(db: Db, userId: string, concertId: string, min: Role): Promise<Role> {
  const role = await concertRole(db, userId, concertId);
  if (!role) throw new HTTPException(404, { message: "Concert not found" });
  if (rank[role] < rank[min]) throw new HTTPException(403, { message: `Needs ${min} access` });
  return role;
}

export function atLeast(role: Role | null, min: Role) {
  return !!role && rank[role] >= rank[min];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

export function assertUuid(s: string, what = "Item") {
  if (!isUuid(s)) throw new HTTPException(404, { message: `${what} not found` });
}
