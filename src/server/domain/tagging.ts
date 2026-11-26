import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { concertMembers, labels, people, photoLabels, photoPeople, photos } from "../db/schema.js";
import { requirePhotosEditable } from "./photos.js";
import { findOrCreateLabel, findOrCreatePerson } from "./people.js";

const coord = z.number().min(0).max(1);
const ref = z.union([z.object({ id: z.string().uuid() }), z.object({ name: z.string().trim().min(1).max(120) })]);

export const bulkTagInput = z.object({
  photoIds: z.array(z.string()).min(1).max(1000),
  addLabels: z.array(ref).max(50).default([]),
  removeLabels: z.array(z.string().uuid()).max(50).default([]),
  addPeople: z.array(z.intersection(ref, z.object({ x: coord.optional(), y: coord.optional() }))).max(50).default([]),
  removePeople: z.array(z.string().uuid()).max(50).default([]),
});
export type BulkTagInput = z.input<typeof bulkTagInput>;

/**
 * Adds/removes labels and people on one or many photos. Labels and people come from the caller's
 * own lists (names are created on the fly). Returns the people that were newly tagged, for notifications.
 */
export async function bulkTag(db: Db, userId: string, raw: BulkTagInput) {
  const input = bulkTagInput.parse(raw);
  await requirePhotosEditable(db, userId, input.photoIds);
  const photoIds = [...new Set(input.photoIds)];

  const labelIds: string[] = [];
  for (const l of input.addLabels) {
    if ("id" in l) {
      const [own] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.id, l.id), eq(labels.ownerId, userId)));
      if (!own) throw new HTTPException(404, { message: "Label not found" });
      labelIds.push(own.id);
    } else labelIds.push((await findOrCreateLabel(db, userId, l.name)).id);
  }
  const personTags: { id: string; x?: number; y?: number }[] = [];
  for (const p of input.addPeople) {
    let id: string;
    if ("id" in p) {
      const [own] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, p.id), eq(people.ownerId, userId)));
      if (!own) throw new HTTPException(404, { message: "Person not found" });
      id = own.id;
    } else id = (await findOrCreatePerson(db, userId, p.name)).id;
    personTags.push({ id, x: p.x, y: p.y });
  }

  const newlyTagged: string[] = [];
  await db.transaction(async (tx) => {
    if (labelIds.length) {
      await tx
        .insert(photoLabels)
        .values(photoIds.flatMap((photoId) => labelIds.map((labelId) => ({ photoId, labelId }))))
        .onConflictDoNothing();
    }
    if (input.removeLabels.length) {
      await tx.delete(photoLabels).where(and(inArray(photoLabels.photoId, photoIds), inArray(photoLabels.labelId, input.removeLabels)));
    }
    for (const t of personTags) {
      const pin = t.x !== undefined && t.y !== undefined;
      const inserted = await tx
        .insert(photoPeople)
        .values(photoIds.map((photoId) => ({ photoId, personId: t.id, taggedBy: userId, x: pin ? t.x : null, y: pin ? t.y : null })))
        .onConflictDoUpdate({
          target: [photoPeople.photoId, photoPeople.personId],
          set: pin ? { x: t.x, y: t.y } : { x: sql`${photoPeople.x}` },
        })
        .returning({ photoId: photoPeople.photoId, createdAt: photoPeople.createdAt, xmax: sql<string>`xmax` });
      // xmax = 0 means a fresh insert rather than an update of an existing tag.
      if (inserted.some((r) => r.xmax === "0")) newlyTagged.push(t.id);
    }
    if (input.removePeople.length) {
      // Only the caller's own people can be untagged this way (others use "untag me").
      await tx.delete(photoPeople).where(
        and(
          inArray(photoPeople.photoId, photoIds),
          inArray(photoPeople.personId, input.removePeople),
          sql`${photoPeople.personId} in (select id from people where owner_id = ${userId})`,
        ),
      );
    }
  });
  return { photoIds, newlyTaggedPeople: [...new Set(newlyTagged)] };
}

/** The tagged user removes their own tag from a photo (not the photo itself). */
export async function untagMe(db: Db, userId: string, photoId: string) {
  const [visible] = await db
    .select({ id: photos.id })
    .from(photos)
    .innerJoin(concertMembers, and(eq(concertMembers.concertId, photos.concertId), eq(concertMembers.userId, userId)))
    .where(eq(photos.id, photoId));
  if (!visible) throw new HTTPException(404, { message: "Photo not found" });
  const removed = await db
    .delete(photoPeople)
    .where(and(eq(photoPeople.photoId, photoId), sql`${photoPeople.personId} in (select id from people where linked_user_id = ${userId})`))
    .returning();
  return removed.length;
}
