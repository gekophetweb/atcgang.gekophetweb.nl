import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import { currentUser, type Env } from "../context.js";
import {
  acceptInvite,
  concertFilters,
  concertInput,
  concertPatch,
  createConcert,
  createInvite,
  deleteConcert,
  getConcert,
  inviteInput,
  listConcerts,
  previewInvite,
  removeMember,
  revokeInvite,
  setConcertPeople,
  setMemberRole,
  updateConcert,
} from "../domain/concerts.js";
import { toIcs } from "../lib/ics.js";
import { inviteMail } from "../mail-templates.js";
import { concerts } from "../db/schema.js";
import { requireConcertRole } from "../access.js";

export function concertRoutes(deps: AppDeps) {
  const { db, config, mailer, storage } = deps;
  const r = new Hono<Env>();

  r.get("/concerts", async (c) => {
    const f = concertFilters.parse(c.req.query());
    return c.json(await listConcerts(db, currentUser(c).id, f));
  });

  r.post("/concerts", async (c) => {
    const input = concertInput.parse(await c.req.json());
    return c.json(await createConcert(db, currentUser(c), input), 201);
  });

  r.get("/concerts/:id", async (c) => c.json(await getConcert(db, currentUser(c).id, c.req.param("id"))));

  r.patch("/concerts/:id", async (c) => {
    const patch = concertPatch.parse(await c.req.json());
    return c.json(await updateConcert(db, currentUser(c).id, c.req.param("id"), patch));
  });

  r.delete("/concerts/:id", async (c) => {
    const id = c.req.param("id");
    await deleteConcert(db, currentUser(c).id, id);
    await storage.deletePrefix(`photos/${id}/`);
    return c.body(null, 204);
  });

  r.put("/concerts/:id/people", async (c) => {
    const { personIds } = z.object({ personIds: z.array(z.string()).max(200) }).parse(await c.req.json());
    await setConcertPeople(db, currentUser(c).id, c.req.param("id"), personIds);
    return c.body(null, 204);
  });

  r.get("/concerts/:id/ics", async (c) => {
    const id = c.req.param("id");
    await requireConcertRole(db, currentUser(c).id, id, "viewer");
    const [k] = await db.select().from(concerts).where(eq(concerts.id, id));
    const ics = toIcs({
      uid: `${k!.id}@atcgang.gekophetweb.nl`,
      start: k!.startsAt,
      end: k!.endsAt,
      summary: k!.title ? `${k!.artist} – ${k!.title}` : k!.artist,
      location: [k!.venue, k!.city, k!.country].filter(Boolean).join(", "),
      description: [k!.ticketInfo, k!.setlistUrl, k!.notes].filter(Boolean).join("\n\n"),
      url: `${config.BASE_URL}/concerts/${k!.id}`,
      cancelled: k!.status === "cancelled",
    });
    const filename = `${k!.artist.replace(/[^\w-]+/g, "-").slice(0, 60) || "concert"}.ics`;
    return c.body(ics, 200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    });
  });

  // Members
  r.patch("/concerts/:id/members/:userId", async (c) => {
    const { role } = z.object({ role: z.enum(["editor", "viewer"]) }).parse(await c.req.json());
    await setMemberRole(db, currentUser(c).id, c.req.param("id"), c.req.param("userId"), role);
    return c.body(null, 204);
  });
  r.delete("/concerts/:id/members/:userId", async (c) => {
    await removeMember(db, currentUser(c).id, c.req.param("id"), c.req.param("userId"));
    return c.body(null, 204);
  });

  // Invites
  r.post("/concerts/:id/invites", async (c) => {
    const me = currentUser(c);
    const input = inviteInput.parse(await c.req.json());
    const concert = await getConcert(db, me.id, c.req.param("id"));
    const { invite, token } = await createInvite(db, me.id, concert.id, input);
    const url = `${config.BASE_URL}/invite/${token}`;
    if (input.email) {
      await mailer.send(inviteMail(input.email, me.name || me.email, concert.artist, url));
    }
    return c.json({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, url }, 201);
  });
  r.delete("/concerts/:id/invites/:inviteId", async (c) => {
    await revokeInvite(db, currentUser(c).id, c.req.param("id"), c.req.param("inviteId"));
    return c.body(null, 204);
  });
  r.get("/invites/:token", async (c) => c.json(await previewInvite(db, c.req.param("token"))));
  r.post("/invites/:token/accept", async (c) => {
    const me = currentUser(c);
    const res = await acceptInvite(db, me.id, c.req.param("token"));
    if (!res.alreadyMember) await deps.notify?.inviteAccepted(res.invitedBy, me, res.concertId);
    return c.json(res);
  });

  return r;
}
