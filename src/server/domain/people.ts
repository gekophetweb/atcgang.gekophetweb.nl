import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { concertPeople, labels, people, photoLabels, photoPeople, users } from "../db/schema.js";
import { assertUuid } from "../access.js";

export const personInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Link to the registered user with this email; null unlinks. */
  linkedEmail: z.string().trim().toLowerCase().email().nullish(),
});

export async function listPeople(db: Db, userId: string) {
  return db
    .select({
      id: people.id,
      name: people.name,
      linkedUserId: people.linkedUserId,
      linkedUserName: users.name,
      linkedUserImage: users.image,
      concertCount: sql<number>`(select count(*)::int from ${concertPeople} where ${concertPeople.personId} = ${people.id})`,
      photoCount: sql<number>`(select count(*)::int from ${photoPeople} where ${photoPeople.personId} = ${people.id})`,
    })
    .from(people)
    .leftJoin(users, eq(users.id, people.linkedUserId))
    .where(eq(people.ownerId, userId))
    .orderBy(asc(people.name));
}

async function resolveLinkedUser(db: Db, email: string | null | undefined) {
  if (email === undefined) return undefined;
  if (email === null) return null;
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!u) throw new HTTPException(404, { message: "No ATC Gang account with that email" });
  return u.id;
}

export async function ownPerson(db: Db, userId: string, id: string) {
  assertUuid(id, "Person");
  const [p] = await db.select().from(people).where(and(eq(people.id, id), eq(people.ownerId, userId)));
  if (!p) throw new HTTPException(404, { message: "Person not found" });
  return p;
}

export async function createPerson(db: Db, userId: string, input: z.infer<typeof personInput>) {
  const linkedUserId = await resolveLinkedUser(db, input.linkedEmail);
  const [p] = await db
    .insert(people)
    .values({ ownerId: userId, name: input.name, linkedUserId: linkedUserId ?? null })
    .returning();
  return p!;
}

/** Finds the user's person by name (case-insensitive) or creates it. */
export async function findOrCreatePerson(db: Db, userId: string, name: string) {
  const clean = name.trim();
  const [p] = await db
    .select()
    .from(people)
    .where(and(eq(people.ownerId, userId), sql`lower(${people.name}) = lower(${clean})`))
    .limit(1);
  return p ?? createPerson(db, userId, { name: clean });
}

export async function updatePerson(db: Db, userId: string, id: string, input: Partial<z.infer<typeof personInput>>) {
  await ownPerson(db, userId, id);
  const linkedUserId = await resolveLinkedUser(db, input.linkedEmail);
  const [p] = await db
    .update(people)
    .set({ ...(input.name ? { name: input.name } : {}), ...(linkedUserId !== undefined ? { linkedUserId } : {}) })
    .where(eq(people.id, id))
    .returning();
  return p!;
}

export async function deletePerson(db: Db, userId: string, id: string) {
  await ownPerson(db, userId, id);
  await db.delete(people).where(eq(people.id, id));
}

/** Merges duplicate `sourceId` into `targetId`: concerts and photo tags move over, the duplicate goes. */
export async function mergePeople(db: Db, userId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HTTPException(400, { message: "Pick two different people" });
  const [src, dst] = await Promise.all([ownPerson(db, userId, sourceId), ownPerson(db, userId, targetId)]);
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into concert_people (concert_id, person_id)
      select concert_id, ${dst.id} from concert_people where person_id = ${src.id} on conflict do nothing`);
    await tx.execute(sql`insert into photo_people (photo_id, person_id, tagged_by, x, y, created_at)
      select photo_id, ${dst.id}, tagged_by, x, y, created_at from photo_people where person_id = ${src.id} on conflict do nothing`);
    if (!dst.linkedUserId && src.linkedUserId) {
      await tx.update(people).set({ linkedUserId: src.linkedUserId }).where(eq(people.id, dst.id));
    }
    await tx.delete(people).where(eq(people.id, src.id));
  });
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const labelInput = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export async function listLabels(db: Db, userId: string) {
  return db
    .select({
      id: labels.id,
      name: labels.name,
      color: labels.color,
      photoCount: sql<number>`(select count(*)::int from ${photoLabels} where ${photoLabels.labelId} = ${labels.id})`,
    })
    .from(labels)
    .where(eq(labels.ownerId, userId))
    .orderBy(asc(labels.name));
}

export async function ownLabel(db: Db, userId: string, id: string) {
  assertUuid(id, "Label");
  const [l] = await db.select().from(labels).where(and(eq(labels.id, id), eq(labels.ownerId, userId)));
  if (!l) throw new HTTPException(404, { message: "Label not found" });
  return l;
}

export async function createLabel(db: Db, userId: string, input: z.infer<typeof labelInput>) {
  const [l] = await db
    .insert(labels)
    .values({ ownerId: userId, name: input.name, ...(input.color ? { color: input.color } : {}) })
    .onConflictDoNothing()
    .returning();
  if (l) return l;
  const [existing] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.ownerId, userId), eq(labels.name, input.name)));
  return existing!;
}

/** Finds the user's label by name (case-insensitive) or creates it. */
export async function findOrCreateLabel(db: Db, userId: string, name: string) {
  const [l] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.ownerId, userId), sql`lower(${labels.name}) = lower(${name.trim()})`))
    .limit(1);
  return l ?? createLabel(db, userId, { name: name.trim() });
}

export async function updateLabel(db: Db, userId: string, id: string, input: Partial<z.infer<typeof labelInput>>) {
  await ownLabel(db, userId, id);
  try {
    const [l] = await db.update(labels).set(input).where(eq(labels.id, id)).returning();
    return l!;
  } catch (e) {
    if (String((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === "23505")
      throw new HTTPException(409, { message: "You already have a label with that name" });
    throw e;
  }
}

export async function deleteLabel(db: Db, userId: string, id: string) {
  await ownLabel(db, userId, id);
  await db.delete(labels).where(eq(labels.id, id));
}

export async function mergeLabels(db: Db, userId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HTTPException(400, { message: "Pick two different labels" });
  const [src, dst] = await Promise.all([ownLabel(db, userId, sourceId), ownLabel(db, userId, targetId)]);
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into photo_labels (photo_id, label_id)
      select photo_id, ${dst.id} from photo_labels where label_id = ${src.id} on conflict do nothing`);
    await tx.delete(labels).where(eq(labels.id, src.id));
  });
}
