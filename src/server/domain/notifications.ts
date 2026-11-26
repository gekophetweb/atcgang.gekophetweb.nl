import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { concertMembers, concerts, notifications, people, photoPeople, photos, tagEmailBatches, users } from "../db/schema.js";
import type { Jobs } from "../lib/jobs.js";
import type { Mailer } from "../lib/mailer.js";
import { signPhotoUrl } from "../lib/signed-url.js";
import { tagMail } from "../mail-templates.js";

export const TAG_EMAIL_DELAY_MS = 15 * 60 * 1000;
const GROUP_WINDOW_MS = 15 * 60 * 1000;

interface Deps {
  db: Db;
  jobs: Jobs;
  mailer: Mailer;
  baseUrl: string;
  secret: string;
}

/**
 * Adds to an unread notification of the same kind (same actor + concert, recent) or starts a new one,
 * so bulk actions show as "Anna tagged you in 12 photos" rather than 12 rows.
 */
async function bump(db: Db, userId: string, type: string, actorId: string, actorName: string, concertId: string, artist: string, photoIds: string[]) {
  const [existing] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, type),
        isNull(notifications.readAt),
        gte(notifications.createdAt, new Date(Date.now() - GROUP_WINDOW_MS)),
        sql`${notifications.payload}->>'actorId' = ${actorId}`,
        sql`${notifications.payload}->>'concertId' = ${concertId}`,
      ),
    )
    .limit(1);
  if (existing) {
    const ids = [...new Set([...((existing.payload.photoIds as string[]) ?? []), ...photoIds])];
    await db
      .update(notifications)
      .set({ payload: { ...existing.payload, photoIds: ids, count: ids.length } })
      .where(eq(notifications.id, existing.id));
  } else {
    await db.insert(notifications).values({
      userId,
      type,
      payload: { actorId, actorName, concertId, artist, photoIds, count: photoIds.length },
    });
  }
}

export function createNotifier(deps: Deps) {
  const { db, jobs, mailer } = deps;

  return {
    /** After people were tagged on photos: notify linked users who are members of the concert. */
    async tagged(tagger: { id: string; name: string }, photoIds: string[], personIds: string[]) {
      if (!photoIds.length || !personIds.length) return;
      const rows = await db
        .selectDistinct({ userId: people.linkedUserId, photoId: photos.id, concertId: photos.concertId, artist: concerts.artist })
        .from(photoPeople)
        .innerJoin(people, eq(people.id, photoPeople.personId))
        .innerJoin(photos, eq(photos.id, photoPeople.photoId))
        .innerJoin(concerts, eq(concerts.id, photos.concertId))
        .innerJoin(concertMembers, and(eq(concertMembers.concertId, photos.concertId), eq(concertMembers.userId, people.linkedUserId)))
        .where(and(inArray(photoPeople.photoId, photoIds), inArray(photoPeople.personId, personIds)));

      const groups = new Map<string, { userId: string; concertId: string; artist: string; photoIds: string[] }>();
      for (const r of rows) {
        if (!r.userId || r.userId === tagger.id) continue;
        const k = `${r.userId}:${r.concertId}`;
        const g = groups.get(k) ?? { userId: r.userId, concertId: r.concertId, artist: r.artist, photoIds: [] };
        g.photoIds.push(r.photoId);
        groups.set(k, g);
      }
      for (const g of groups.values()) {
        await bump(db, g.userId, "tagged", tagger.id, tagger.name, g.concertId, g.artist, g.photoIds);
        await scheduleTagEmail(g.userId, tagger.id, g.concertId);
      }
    },

    async photosAdded(uploader: { id: string; name: string }, concertId: string, photoId: string) {
      const [c] = await db.select({ artist: concerts.artist }).from(concerts).where(eq(concerts.id, concertId));
      const members = await db.select({ userId: concertMembers.userId }).from(concertMembers).where(eq(concertMembers.concertId, concertId));
      for (const m of members) {
        if (m.userId !== uploader.id) await bump(db, m.userId, "photos_added", uploader.id, uploader.name, concertId, c?.artist ?? "", [photoId]);
      }
    },

    async inviteAccepted(inviterId: string, accepter: { id: string; name: string; email: string }, concertId: string) {
      const [c] = await db.select({ artist: concerts.artist }).from(concerts).where(eq(concerts.id, concertId));
      await db.insert(notifications).values({
        userId: inviterId,
        type: "invite_accepted",
        payload: { actorId: accepter.id, actorName: accepter.name || accepter.email, concertId, artist: c?.artist ?? "" },
      });
    },

    /** pg-boss job: send one email for everything `taggerId` tagged `userId` in during the window. */
    async sendTagEmail(batchId: string) {
      const [b] = await db.select().from(tagEmailBatches).where(eq(tagEmailBatches.id, batchId));
      if (!b || b.sentAt) return;
      await db.update(tagEmailBatches).set({ sentAt: new Date() }).where(eq(tagEmailBatches.id, b.id));
      const [u] = await db.select().from(users).where(eq(users.id, b.userId));
      if (!u || !u.emailNotifications || u.disabled) return;
      // Still-existing tags only: untagging before the email goes out cancels it.
      const tagged = await db
        .selectDistinct({ id: photos.id, at: photoPeople.createdAt })
        .from(photoPeople)
        .innerJoin(people, eq(people.id, photoPeople.personId))
        .innerJoin(photos, eq(photos.id, photoPeople.photoId))
        .innerJoin(concertMembers, and(eq(concertMembers.concertId, photos.concertId), eq(concertMembers.userId, b.userId)))
        .where(
          and(
            eq(people.linkedUserId, b.userId),
            eq(photoPeople.taggedBy, b.taggerId),
            eq(photos.concertId, b.concertId),
            gte(photoPeople.createdAt, new Date(b.createdAt.getTime() - 1000)),
          ),
        )
        .orderBy(desc(photoPeople.createdAt));
      if (!tagged.length) return;
      const [tagger] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, b.taggerId));
      const [c] = await db.select().from(concerts).where(eq(concerts.id, b.concertId));
      const thumbs = tagged.slice(0, 6).map((t) => signPhotoUrl(deps.baseUrl, deps.secret, t.id, "thumb", 7 * 24 * 3600));
      await mailer.send(
        tagMail(
          u.email,
          tagger?.name || tagger?.email || "Someone",
          tagged.length,
          [c?.artist, c?.venue].filter(Boolean).join(", "),
          `${deps.baseUrl}/photos/me`,
          thumbs,
        ),
      );
    },
  };

  async function scheduleTagEmail(userId: string, taggerId: string, concertId: string) {
    const [open] = await db
      .select({ id: tagEmailBatches.id })
      .from(tagEmailBatches)
      .where(
        and(
          eq(tagEmailBatches.userId, userId),
          eq(tagEmailBatches.taggerId, taggerId),
          eq(tagEmailBatches.concertId, concertId),
          isNull(tagEmailBatches.sentAt),
        ),
      )
      .limit(1);
    if (open) return;
    const sendAfter = new Date(Date.now() + TAG_EMAIL_DELAY_MS);
    const [b] = await db.insert(tagEmailBatches).values({ userId, taggerId, concertId, sendAfter }).returning();
    await jobs.send("tag-emails", { batchId: b!.id }, { startAfter: sendAfter, singletonKey: b!.id });
  }
}

export type AppNotifier = ReturnType<typeof createNotifier>;

export async function listNotifications(db: Db, userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(50);
}

export async function unreadCount(db: Db, userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export async function markRead(db: Db, userId: string, ids: string[] | "all") {
  const where = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids !== "all") {
    if (!ids.length) return;
    where.push(inArray(notifications.id, ids));
  }
  await db.update(notifications).set({ readAt: new Date() }).where(and(...where));
}
