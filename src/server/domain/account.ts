import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import type { Db } from "../db/client.js";
import {
  concertMembers,
  concertPeople,
  concerts,
  labels,
  people,
  photoLabels,
  photoPeople,
  photos,
  sessions,
  users,
} from "../db/schema.js";
import { requireConcertRole } from "../access.js";
import type { Storage } from "../lib/storage.js";
import { keys } from "./photos.js";

async function movePhotoFiles(storage: Storage, fromConcert: string, toConcert: string, photoId: string) {
  await storage.move(keys.original(fromConcert, photoId), keys.original(toConcert, photoId));
  await storage.move(keys.thumb(fromConcert, photoId), keys.thumb(toConcert, photoId));
  await storage.move(keys.large(fromConcert, photoId), keys.large(toConcert, photoId));
}

/**
 * Merges the caller's duplicate concert into a shared one: photos, people and notes move over,
 * members of the duplicate join the target, and the duplicate is deleted.
 */
export async function mergeConcert(db: Db, storage: Storage, userId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HTTPException(400, { message: "Pick two different concerts" });
  await requireConcertRole(db, userId, sourceId, "owner");
  await requireConcertRole(db, userId, targetId, "editor");
  const [src] = await db.select().from(concerts).where(eq(concerts.id, sourceId));
  const moved = await db.select({ id: photos.id }).from(photos).where(eq(photos.concertId, sourceId));

  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into concert_people (concert_id, person_id)
      select ${targetId}, person_id from concert_people where concert_id = ${sourceId} on conflict do nothing`);
    await tx.execute(sql`insert into concert_members (concert_id, user_id, role)
      select ${targetId}, user_id, case when role = 'owner' then 'editor'::member_role else role end
      from concert_members where concert_id = ${sourceId} on conflict do nothing`);
    for (const p of moved) {
      await tx
        .update(photos)
        .set({ concertId: targetId, storageKey: keys.original(targetId, p.id) })
        .where(eq(photos.id, p.id));
    }
    if (src!.notes.trim()) {
      await tx
        .update(concerts)
        .set({ notes: sql`case when ${concerts.notes} = '' then ${src!.notes} else ${concerts.notes} || E'\\n\\n' || ${src!.notes} end` })
        .where(eq(concerts.id, targetId));
    }
    await tx.delete(concerts).where(eq(concerts.id, sourceId));
  });
  for (const p of moved) await movePhotoFiles(storage, sourceId, targetId, p.id);
  return { merged: moved.length };
}

/** Everything the user has, as JSON, plus the photos they uploaded – streamed as one zip. */
export async function exportData(db: Db, storage: Storage, userId: string) {
  const [me] = await db
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt, emailNotifications: users.emailNotifications })
    .from(users)
    .where(eq(users.id, userId));
  const memberOf = await db
    .select({ concert: concerts, role: concertMembers.role })
    .from(concertMembers)
    .innerJoin(concerts, eq(concerts.id, concertMembers.concertId))
    .where(eq(concertMembers.userId, userId))
    .orderBy(asc(concerts.startsAt));
  const myPeople = await db.select().from(people).where(eq(people.ownerId, userId));
  const myLabels = await db.select().from(labels).where(eq(labels.ownerId, userId));
  const concertIds = memberOf.map((m) => m.concert.id);
  const myPhotos = await db.select().from(photos).where(eq(photos.uploaderId, userId));
  const photoIds = myPhotos.map((p) => p.id);
  const [cp, pl, pp] = await Promise.all([
    concertIds.length ? db.select().from(concertPeople).where(inArray(concertPeople.concertId, concertIds)) : [],
    photoIds.length ? db.select().from(photoLabels).where(inArray(photoLabels.photoId, photoIds)) : [],
    photoIds.length ? db.select().from(photoPeople).where(inArray(photoPeople.photoId, photoIds)) : [],
  ]);
  const myPeopleIds = new Set(myPeople.map((p) => p.id));

  const data = {
    exportedAt: new Date().toISOString(),
    user: me,
    concerts: memberOf.map((m) => ({
      ...m.concert,
      myRole: m.role,
      people: cp.filter((x) => x.concertId === m.concert.id && myPeopleIds.has(x.personId)).map((x) => x.personId),
    })),
    people: myPeople,
    labels: myLabels,
    photos: myPhotos.map(({ storageKey: _k, ...p }) => ({
      ...p,
      file: `photos/${p.id}.${p.mime === "image/png" ? "png" : p.mime === "image/webp" ? "webp" : "jpg"}`,
      labels: pl.filter((x) => x.photoId === p.id).map((x) => x.labelId),
      people: pp.filter((x) => x.photoId === p.id).map((x) => ({ personId: x.personId, x: x.x, y: x.y })),
    })),
  };

  const out = new PassThrough();
  const zip = new ZipArchive({ zlib: { level: 1 } });
  zip.on("error", (e: Error) => out.destroy(e));
  zip.pipe(out);
  zip.append(JSON.stringify(data, null, 2), { name: "data.json" });
  void (async () => {
    for (const p of data.photos) {
      const src = myPhotos.find((x) => x.id === p.id)!;
      const f = await storage.stream(src.storageKey);
      if (f) zip.append(f.stream, { name: p.file });
    }
    await zip.finalize();
  })().catch((e) => out.destroy(e));
  return out;
}

/**
 * Deletes an account: owned concerts with other members pass to the longest-standing member
 * (editors first); owned concerts nobody else is in are deleted with their photos; photos the user
 * uploaded elsewhere are deleted too. Then the user row (and everything hanging off it) goes.
 */
export async function deleteAccount(db: Db, storage: Storage, userId: string) {
  const owned = await db
    .select({ id: concertMembers.concertId })
    .from(concertMembers)
    .where(and(eq(concertMembers.userId, userId), eq(concertMembers.role, "owner")));

  const filesToDelete: { concertId: string; id: string }[] = [];
  for (const { id } of owned) {
    const [heir] = await db
      .select({ userId: concertMembers.userId })
      .from(concertMembers)
      .where(and(eq(concertMembers.concertId, id), ne(concertMembers.userId, userId)))
      .orderBy(sql`case when ${concertMembers.role} = 'editor' then 0 else 1 end`, asc(concertMembers.createdAt))
      .limit(1);
    if (heir) {
      await db.transaction(async (tx) => {
        await tx.update(concertMembers).set({ role: "owner" }).where(and(eq(concertMembers.concertId, id), eq(concertMembers.userId, heir.userId)));
        await tx.update(concerts).set({ ownerId: heir.userId }).where(eq(concerts.id, id));
      });
    } else {
      const ps = await db.select({ id: photos.id, concertId: photos.concertId }).from(photos).where(eq(photos.concertId, id));
      filesToDelete.push(...ps);
      await db.delete(concerts).where(eq(concerts.id, id));
      await storage.deletePrefix(`photos/${id}/`);
    }
  }
  const uploaded = await db.select({ id: photos.id, concertId: photos.concertId }).from(photos).where(eq(photos.uploaderId, userId));
  filesToDelete.push(...uploaded);
  await db.delete(users).where(eq(users.id, userId)); // cascades: sessions, accounts, memberships, people, labels, photos, notifications
  for (const p of filesToDelete) await storage.deletePrefix(`photos/${p.concertId}/${p.id}.`);
}

/** Immediately locks the account (no new sessions, existing ones end); the heavy deletion runs as a job. */
export async function lockAccount(db: Db, userId: string) {
  await db.update(users).set({ disabled: true }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminOverview(db: Db, storage: Storage, alertPercent: number) {
  const list = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      disabled: users.disabled,
      createdAt: users.createdAt,
      bytes: sql<number>`(select coalesce(sum(p.bytes), 0)::bigint from photos p where p.uploader_id = "users"."id")`,
      photos: sql<number>`(select count(*)::int from photos p where p.uploader_id = "users"."id")`,
      concerts: sql<number>`(select count(*)::int from concerts c where c.owner_id = "users"."id")`,
    })
    .from(users)
    .orderBy(sql`${users.createdAt} desc`);
  const disk = await storage.disk();
  const totalBytes = list.reduce((n, u) => n + Number(u.bytes), 0);
  const usedPercent = disk ? Math.round(((disk.total - disk.free) / disk.total) * 100) : null;
  const signupsLast7Days = list.filter((u) => Date.now() - u.createdAt.getTime() < 7 * 86400_000).length;
  return {
    users: list.map((u) => ({ ...u, bytes: Number(u.bytes) })),
    totals: { users: list.length, photoBytes: totalBytes, signupsLast7Days },
    disk: disk ? { ...disk, usedPercent, alert: usedPercent !== null && usedPercent >= alertPercent } : null,
  };
}

export async function setUserDisabled(db: Db, adminId: string, userId: string, disabled: boolean) {
  if (adminId === userId) throw new HTTPException(400, { message: "You can't disable yourself" });
  const res = await db.update(users).set({ disabled }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!res.length) throw new HTTPException(404, { message: "User not found" });
  if (disabled) await db.delete(sessions).where(eq(sessions.userId, userId));
}


export async function setUserRole(db: Db, adminId: string, userId: string, role: "user" | "admin") {
  if (adminId === userId && role !== "admin") throw new HTTPException(400, { message: "You can't remove your own admin role" });
  const res = await db.update(users).set({ role }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!res.length) throw new HTTPException(404, { message: "User not found" });
}
