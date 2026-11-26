import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { concertInvites, concertMembers, concertPeople, concerts, people, photos, users } from "../db/schema.js";
import { assertUuid, requireConcertRole, type Role } from "../access.js";

const STATUSES = ["planned", "attending", "attended", "cancelled", "skipped"] as const;
const optText = z.string().trim().max(2000).nullish();
const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === "" || /^https?:\/\//i.test(v), "Must be an http(s) URL")
  .nullish()
  .transform((v) => (v ? v : null));

export const concertInput = z.object({
  artist: z.string().trim().min(1).max(200),
  title: optText,
  venue: z.string().trim().max(200).default(""),
  city: z.string().trim().max(120).default(""),
  country: z.string().trim().max(120).default(""),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullish(),
  status: z.enum(STATUSES).default("planned"),
  ticketInfo: optText,
  setlistUrl: url,
  notes: z.string().max(20000).default(""),
  rating: z.number().int().min(1).max(5).nullish(),
});
export const concertPatch = concertInput.partial();
export type ConcertInput = z.infer<typeof concertInput>;

export const concertFilters = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  person: z.string().uuid().optional(),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  when: z.enum(["upcoming", "past"]).optional(),
  artist: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type ConcertFilters = z.infer<typeof concertFilters>;

/** New accounts (first week) may create at most this many concerts per 24 h. */
export const NEW_ACCOUNT_DAILY_CONCERTS = 25;
const NEW_ACCOUNT_DAYS = 7;

export async function listConcerts(db: Db, userId: string, f: Partial<ConcertFilters> = {}) {
  const now = new Date();
  const where: SQL[] = [eq(concertMembers.userId, userId)];
  if (f.from) where.push(gte(concerts.startsAt, f.from));
  if (f.to) where.push(lt(concerts.startsAt, f.to));
  if (f.status) where.push(eq(concerts.status, f.status));
  if (f.when === "upcoming") where.push(gte(concerts.startsAt, startOfToday(now)));
  if (f.when === "past") where.push(lt(concerts.startsAt, startOfToday(now)));
  if (f.year) where.push(sql`extract(year from ${concerts.startsAt}) = ${f.year}`);
  if (f.artist) where.push(ilike(concerts.artist, `%${likeEscape(f.artist)}%`));
  if (f.q) {
    const q = `%${likeEscape(f.q)}%`;
    where.push(or(ilike(concerts.artist, q), ilike(concerts.venue, q), ilike(concerts.city, q), ilike(concerts.title, q))!);
  }
  if (f.person) {
    where.push(
      sql`exists (select 1 from ${concertPeople} where ${concertPeople.concertId} = ${concerts.id} and ${concertPeople.personId} = ${f.person})`,
    );
  }

  const rows = await db
    .select({
      concert: concerts,
      myRole: concertMembers.role,
      photoCount: sql<number>`(select count(*)::int from ${photos} where ${photos.concertId} = ${concerts.id})`,
    })
    .from(concerts)
    .innerJoin(concertMembers, eq(concertMembers.concertId, concerts.id))
    .where(and(...where))
    .orderBy(f.when === "past" ? desc(concerts.startsAt) : asc(concerts.startsAt))
    .limit(f.limit ?? 500);

  const ids = rows.map((r) => r.concert.id);
  const [members, myPeople] = await Promise.all([membersOf(db, ids), peopleOf(db, ids, userId)]);
  return rows.map((r) => ({
    ...r.concert,
    myRole: r.myRole,
    photoCount: r.photoCount,
    members: members.get(r.concert.id) ?? [],
    people: myPeople.get(r.concert.id) ?? [],
  }));
}

async function membersOf(db: Db, concertIds: string[]) {
  const map = new Map<string, { id: string; name: string; image: string | null; role: Role }[]>();
  if (!concertIds.length) return map;
  const rows = await db
    .select({ concertId: concertMembers.concertId, id: users.id, name: users.name, image: users.image, role: concertMembers.role })
    .from(concertMembers)
    .innerJoin(users, eq(users.id, concertMembers.userId))
    .where(inArray(concertMembers.concertId, concertIds))
    .orderBy(asc(concertMembers.createdAt));
  for (const { concertId, ...m } of rows) map.set(concertId, [...(map.get(concertId) ?? []), m]);
  return map;
}

/** People on a concert, as seen by `userId`: each user's people list is private. */
async function peopleOf(db: Db, concertIds: string[], userId: string) {
  const map = new Map<string, { id: string; name: string; linkedUserId: string | null }[]>();
  if (!concertIds.length) return map;
  const rows = await db
    .select({ concertId: concertPeople.concertId, id: people.id, name: people.name, linkedUserId: people.linkedUserId })
    .from(concertPeople)
    .innerJoin(people, eq(people.id, concertPeople.personId))
    .where(and(inArray(concertPeople.concertId, concertIds), eq(people.ownerId, userId)))
    .orderBy(asc(people.name));
  for (const { concertId, ...p } of rows) map.set(concertId, [...(map.get(concertId) ?? []), p]);
  return map;
}

export async function getConcert(db: Db, userId: string, id: string) {
  const role = await requireConcertRole(db, userId, id, "viewer");
  const [c] = await db.select().from(concerts).where(eq(concerts.id, id));
  if (!c) throw new HTTPException(404, { message: "Concert not found" });
  const [members, myPeople, [pc]] = await Promise.all([
    membersOf(db, [id]),
    peopleOf(db, [id], userId),
    db.select({ n: count() }).from(photos).where(eq(photos.concertId, id)),
  ]);
  const invites =
    role === "owner"
      ? await db
          .select({
            id: concertInvites.id,
            email: concertInvites.email,
            role: concertInvites.role,
            expiresAt: concertInvites.expiresAt,
            acceptedAt: concertInvites.acceptedAt,
          })
          .from(concertInvites)
          .where(and(eq(concertInvites.concertId, id), isNull(concertInvites.acceptedAt), gte(concertInvites.expiresAt, new Date())))
      : [];
  return { ...c, myRole: role, photoCount: pc?.n ?? 0, members: members.get(id) ?? [], people: myPeople.get(id) ?? [], invites };
}

export async function createConcert(db: Db, user: { id: string; createdAt?: Date }, input: ConcertInput) {
  await enforceNewAccountLimit(db, user.id);
  validateRange(input.startsAt, input.endsAt);
  return db.transaction(async (tx) => {
    const [c] = await tx
      .insert(concerts)
      .values({ ...input, ownerId: user.id })
      .returning();
    await tx.insert(concertMembers).values({ concertId: c!.id, userId: user.id, role: "owner" });
    return c!;
  });
}

async function enforceNewAccountLimit(db: Db, userId: string) {
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  if (!u || Date.now() - u.createdAt.getTime() > NEW_ACCOUNT_DAYS * 86400_000) return;
  const [r] = await db
    .select({ n: count() })
    .from(concerts)
    .where(and(eq(concerts.ownerId, userId), gte(concerts.createdAt, new Date(Date.now() - 86400_000))));
  if ((r?.n ?? 0) >= NEW_ACCOUNT_DAILY_CONCERTS) {
    throw new HTTPException(429, { message: "New accounts can add a limited number of concerts per day. Try again tomorrow." });
  }
}

function validateRange(start?: Date, end?: Date | null) {
  if (start && end && end < start) throw new HTTPException(400, { message: "End must be after start" });
}

export async function updateConcert(db: Db, userId: string, id: string, patch: z.infer<typeof concertPatch>) {
  await requireConcertRole(db, userId, id, "editor");
  const [cur] = await db.select().from(concerts).where(eq(concerts.id, id));
  validateRange(patch.startsAt ?? cur!.startsAt, patch.endsAt === undefined ? cur!.endsAt : patch.endsAt);
  const [c] = await db.update(concerts).set(patch).where(eq(concerts.id, id)).returning();
  return c!;
}

/** Deletes a concert (owner only). Returns the storage keys of its photos so the caller can remove the files. */
export async function deleteConcert(db: Db, userId: string, id: string): Promise<string[]> {
  await requireConcertRole(db, userId, id, "owner");
  const keys = await db.select({ key: photos.storageKey }).from(photos).where(eq(photos.concertId, id));
  await db.delete(concerts).where(eq(concerts.id, id));
  return keys.map((k) => k.key);
}

export async function setConcertPeople(db: Db, userId: string, id: string, personIds: string[]) {
  await requireConcertRole(db, userId, id, "editor");
  const unique = [...new Set(personIds)];
  unique.forEach((p) => assertUuid(p, "Person"));
  const mine = unique.length
    ? await db.select({ id: people.id }).from(people).where(and(inArray(people.id, unique), eq(people.ownerId, userId)))
    : [];
  if (mine.length !== unique.length) throw new HTTPException(404, { message: "Person not found" });
  await db.transaction(async (tx) => {
    // Only touch this user's own people; other members' people stay.
    await tx.delete(concertPeople).where(
      and(
        eq(concertPeople.concertId, id),
        sql`${concertPeople.personId} in (select ${people.id} from ${people} where ${people.ownerId} = ${userId})`,
      ),
    );
    if (unique.length) await tx.insert(concertPeople).values(unique.map((personId) => ({ concertId: id, personId })));
  });
}

// ---------------------------------------------------------------------------
// Members & invites
// ---------------------------------------------------------------------------

export async function setMemberRole(db: Db, userId: string, concertId: string, memberId: string, role: Exclude<Role, "owner">) {
  await requireConcertRole(db, userId, concertId, "owner");
  if (memberId === userId) throw new HTTPException(400, { message: "You are the owner" });
  const res = await db
    .update(concertMembers)
    .set({ role })
    .where(and(eq(concertMembers.concertId, concertId), eq(concertMembers.userId, memberId)))
    .returning();
  if (!res.length) throw new HTTPException(404, { message: "Member not found" });
}

/** Owner removes a member, or a member leaves. The owner can't leave (delete the concert or transfer instead). */
export async function removeMember(db: Db, userId: string, concertId: string, memberId: string) {
  const role = await requireConcertRole(db, userId, concertId, "viewer");
  if (memberId !== userId && role !== "owner") throw new HTTPException(403, { message: "Only the owner can remove members" });
  const target = await db
    .select({ role: concertMembers.role })
    .from(concertMembers)
    .where(and(eq(concertMembers.concertId, concertId), eq(concertMembers.userId, memberId)));
  if (!target[0]) throw new HTTPException(404, { message: "Member not found" });
  if (target[0].role === "owner") throw new HTTPException(400, { message: "The owner can't leave their own concert" });
  await db.delete(concertMembers).where(and(eq(concertMembers.concertId, concertId), eq(concertMembers.userId, memberId)));
}

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  role: z.enum(["editor", "viewer"]).default("editor"),
});

const INVITE_DAYS = 14;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createInvite(db: Db, userId: string, concertId: string, input: z.infer<typeof inviteInput>) {
  await requireConcertRole(db, userId, concertId, "owner");
  const token = randomBytes(24).toString("base64url");
  const [inv] = await db
    .insert(concertInvites)
    .values({
      concertId,
      invitedBy: userId,
      email: input.email ?? null,
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86400_000),
    })
    .returning();
  return { invite: inv!, token };
}

export async function revokeInvite(db: Db, userId: string, concertId: string, inviteId: string) {
  await requireConcertRole(db, userId, concertId, "owner");
  assertUuid(inviteId, "Invite");
  await db.delete(concertInvites).where(and(eq(concertInvites.id, inviteId), eq(concertInvites.concertId, concertId)));
}

async function findInvite(db: Db, token: string) {
  const [row] = await db
    .select({ invite: concertInvites, concert: concerts, inviter: { name: users.name } })
    .from(concertInvites)
    .innerJoin(concerts, eq(concerts.id, concertInvites.concertId))
    .innerJoin(users, eq(users.id, concertInvites.invitedBy))
    .where(eq(concertInvites.tokenHash, hashToken(token)));
  if (!row || row.invite.expiresAt < new Date()) throw new HTTPException(404, { message: "This invite is invalid or has expired" });
  // Email invites are single use; share links (no email) can be used until they expire.
  if (row.invite.email && row.invite.acceptedAt) throw new HTTPException(410, { message: "This invite has already been used" });
  return row;
}

export async function previewInvite(db: Db, token: string) {
  const { invite, concert, inviter } = await findInvite(db, token);
  return {
    concert: { id: concert.id, artist: concert.artist, title: concert.title, venue: concert.venue, city: concert.city, startsAt: concert.startsAt },
    inviter: inviter.name,
    role: invite.role,
  };
}

/**
 * Accepts an invite. If the user already has a concert by the same artist on the same day,
 * returns it as `duplicateOf` so the UI can offer to merge it into the shared one.
 */
export async function acceptInvite(db: Db, userId: string, token: string) {
  const { invite, concert } = await findInvite(db, token);
  const existing = await db
    .select({ role: concertMembers.role })
    .from(concertMembers)
    .where(and(eq(concertMembers.concertId, concert.id), eq(concertMembers.userId, userId)));
  if (!existing.length) {
    await db.insert(concertMembers).values({ concertId: concert.id, userId, role: invite.role });
  }
  await db
    .update(concertInvites)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(concertInvites.id, invite.id), isNull(concertInvites.acceptedAt)));

  const [dup] = await db
    .select({ id: concerts.id })
    .from(concerts)
    .innerJoin(concertMembers, and(eq(concertMembers.concertId, concerts.id), eq(concertMembers.userId, userId)))
    .where(
      and(
        eq(concertMembers.role, "owner"),
        sql`lower(${concerts.artist}) = lower(${concert.artist})`,
        sql`${concerts.startsAt}::date = ${concert.startsAt.toISOString()}::timestamptz::date`,
        sql`${concerts.id} <> ${concert.id}`,
      ),
    )
    .limit(1);
  return { concertId: concert.id, invitedBy: invite.invitedBy, alreadyMember: existing.length > 0, duplicateOf: dup?.id ?? null };
}

function startOfToday(now: Date) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
