import { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import sharp from "sharp";
import exifr from "exifr";
import type { Db } from "../db/client.js";
import { concertMembers, concerts, labels, people, photoLabels, photoPeople, photos } from "../db/schema.js";
import { assertUuid, atLeast, concertRole, requireConcertRole } from "../access.js";
import { TooLargeError, type Storage } from "../lib/storage.js";
import type { Jobs } from "../lib/jobs.js";

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const THUMB_PX = 400;
export const LARGE_PX = 1600;

export const keys = {
  original: (concertId: string, photoId: string) => `photos/${concertId}/${photoId}.orig`,
  thumb: (concertId: string, photoId: string) => `photos/${concertId}/${photoId}.thumb.webp`,
  large: (concertId: string, photoId: string) => `photos/${concertId}/${photoId}.large.webp`,
};

/** Detects the image type from magic bytes – the extension and Content-Type are not trusted. */
export function sniffMime(head: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  if (
    head.length >= 12 &&
    String.fromCharCode(...head.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...head.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Reads the first `n` bytes of a stream and returns them plus a stream that replays everything. */
async function peek(body: ReadableStream<Uint8Array>, n: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let len = 0;
  let done = false;
  while (len < n && !done) {
    const r = await reader.read();
    if (r.done) done = true;
    else {
      chunks.push(r.value);
      len += r.value.length;
    }
  }
  const head = Buffer.concat(chunks);
  async function* rest() {
    yield head;
    if (done) return;
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      yield Buffer.from(r.value);
    }
  }
  return { head, stream: Readable.from(rest()) };
}

export async function usedBytes(db: Db, userId: string) {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${photos.bytes}), 0)::bigint` })
    .from(photos)
    .where(eq(photos.uploaderId, userId));
  return Number(r?.n ?? 0);
}

export interface UploadDeps {
  db: Db;
  storage: Storage;
  jobs: Jobs;
  quotaBytes: number;
}

export async function uploadPhoto(
  deps: UploadDeps,
  userId: string,
  concertId: string,
  body: ReadableStream<Uint8Array> | null,
  opts: { contentLength?: number; takenAt?: Date | null; caption?: string | null },
) {
  const { db, storage, jobs } = deps;
  await requireConcertRole(db, userId, concertId, "editor");
  if (!body) throw new HTTPException(400, { message: "No file" });
  if (opts.contentLength !== undefined && opts.contentLength > MAX_PHOTO_BYTES) {
    throw new HTTPException(413, { message: "Photos can be at most 25 MB" });
  }
  const used = await usedBytes(db, userId);
  const room = deps.quotaBytes - used;
  if (room <= 0 || (opts.contentLength ?? 0) > room) {
    throw new HTTPException(507, { message: "Your photo storage is full" });
  }

  const { head, stream } = await peek(body, 12);
  const mime = sniffMime(head);
  if (!mime) throw new HTTPException(415, { message: "Only JPEG, PNG and WebP photos are supported" });

  const id = crypto.randomUUID();
  const key = keys.original(concertId, id);
  let bytes: number;
  try {
    bytes = await storage.put(key, stream, { maxBytes: Math.min(MAX_PHOTO_BYTES, room) });
  } catch (e) {
    if (e instanceof TooLargeError) {
      throw new HTTPException(e.maxBytes < MAX_PHOTO_BYTES ? 507 : 413, {
        message: e.maxBytes < MAX_PHOTO_BYTES ? "Your photo storage is full" : "Photos can be at most 25 MB",
      });
    }
    throw e;
  }
  const [row] = await db
    .insert(photos)
    .values({ id, concertId, uploaderId: userId, storageKey: key, bytes, mime, takenAt: opts.takenAt ?? null, caption: opts.caption ?? null })
    .returning();
  await jobs.send("thumbnails", { photoId: id });
  return row!;
}

/** pg-boss job: 400 px + 1600 px WebP, real dimensions, EXIF date if the browser didn't send one. */
export async function makeThumbnails(db: Db, storage: Storage, photoId: string) {
  const [p] = await db.select().from(photos).where(eq(photos.id, photoId));
  if (!p) return; // deleted meanwhile
  const original = await storage.get(p.storageKey);
  const img = sharp(original, { failOn: "error" }).rotate();
  const meta = await sharp(original).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const [thumb, large] = await Promise.all([
    img.clone().resize(THUMB_PX, THUMB_PX, { fit: "outside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
    img.clone().resize(LARGE_PX, LARGE_PX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
  ]);
  await storage.put(keys.thumb(p.concertId, p.id), thumb);
  await storage.put(keys.large(p.concertId, p.id), large);
  let takenAt = p.takenAt;
  if (!takenAt) {
    try {
      const exif = await exifr.parse(original, ["DateTimeOriginal", "CreateDate"]);
      const d = exif?.DateTimeOriginal ?? exif?.CreateDate;
      if (d instanceof Date && !Number.isNaN(d.getTime())) takenAt = d;
    } catch {
      /* no EXIF */
    }
  }
  await db
    .update(photos)
    .set({
      width: (swap ? meta.height : meta.width) ?? null,
      height: (swap ? meta.width : meta.height) ?? null,
      takenAt,
      thumbsReady: true,
    })
    .where(eq(photos.id, p.id));
}

export const photoFilters = z.object({
  concert: z.string().uuid().optional(),
  label: z.string().uuid().optional(),
  person: z.string().uuid().optional(),
  me: z
    .enum(["1", "true"])
    .optional()
    .transform((v) => !!v),
  artist: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PhotoFilters = z.infer<typeof photoFilters>;

export async function listPhotos(db: Db, userId: string, f: Partial<PhotoFilters>) {
  const when = sql`coalesce(${photos.takenAt}, ${photos.createdAt})`;
  const where: SQL[] = [eq(concertMembers.userId, userId)];
  if (f.concert) where.push(eq(photos.concertId, f.concert));
  if (f.label) where.push(sql`exists (select 1 from ${photoLabels} where ${photoLabels.photoId} = ${photos.id} and ${photoLabels.labelId} = ${f.label})`);
  if (f.person) where.push(sql`exists (select 1 from ${photoPeople} where ${photoPeople.photoId} = ${photos.id} and ${photoPeople.personId} = ${f.person})`);
  if (f.me) {
    where.push(sql`exists (select 1 from ${photoPeople} pp join ${people} pe on pe.id = pp.person_id
      where pp.photo_id = ${photos.id} and pe.linked_user_id = ${userId})`);
  }
  if (f.artist) where.push(sql`${concerts.artist} ilike ${"%" + f.artist.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}`);
  if (f.year) where.push(sql`extract(year from ${concerts.startsAt}) = ${f.year}`);
  if (f.from) where.push(sql`${when} >= ${f.from.toISOString()}`);
  if (f.to) where.push(sql`${when} < ${f.to.toISOString()}`);

  const rows = await db
    .select({
      id: photos.id,
      concertId: photos.concertId,
      uploaderId: photos.uploaderId,
      width: photos.width,
      height: photos.height,
      bytes: photos.bytes,
      takenAt: photos.takenAt,
      caption: photos.caption,
      thumbsReady: photos.thumbsReady,
      createdAt: photos.createdAt,
      role: concertMembers.role,
      concert: { artist: concerts.artist, startsAt: concerts.startsAt, venue: concerts.venue },
    })
    .from(photos)
    .innerJoin(concertMembers, eq(concertMembers.concertId, photos.concertId))
    .innerJoin(concerts, eq(concerts.id, photos.concertId))
    .where(and(...where))
    .orderBy(f.concert ? asc(when) : desc(when), asc(photos.id))
    .limit(f.limit ?? 200)
    .offset(f.offset ?? 0);
  return withTags(db, userId, rows);
}

async function withTags<T extends { id: string; role: string; uploaderId: string }>(db: Db, userId: string, rows: T[]) {
  const ids = rows.map((r) => r.id);
  const [ls, ps] = ids.length
    ? await Promise.all([
        db
          .select({ photoId: photoLabels.photoId, id: labels.id, name: labels.name, color: labels.color })
          .from(photoLabels)
          .innerJoin(labels, eq(labels.id, photoLabels.labelId))
          .where(inArray(photoLabels.photoId, ids))
          .orderBy(asc(labels.name)),
        db
          .select({
            photoId: photoPeople.photoId,
            id: people.id,
            name: people.name,
            x: photoPeople.x,
            y: photoPeople.y,
            linkedUserId: people.linkedUserId,
            ownerId: people.ownerId,
          })
          .from(photoPeople)
          .innerJoin(people, eq(people.id, photoPeople.personId))
          .where(inArray(photoPeople.photoId, ids))
          .orderBy(asc(people.name)),
      ])
    : [[], []];
  return rows.map(({ role, ...r }) => ({
    ...r,
    canEdit: atLeast(role as "viewer", "editor"),
    canDelete: role === "owner" || r.uploaderId === userId,
    labels: ls.filter((l) => l.photoId === r.id).map(({ photoId: _p, ...l }) => l),
    people: ps.filter((p) => p.photoId === r.id).map(({ photoId: _p, ownerId, ...p }) => ({ ...p, mine: ownerId === userId })),
  }));
}

/** The photo plus the caller's role on its concert; 404 when the caller can't see it. */
export async function photoWithRole(db: Db, userId: string, photoId: string) {
  assertUuid(photoId, "Photo");
  const [p] = await db.select().from(photos).where(eq(photos.id, photoId));
  const role = p ? await concertRole(db, userId, p.concertId) : null;
  if (!p || !role) throw new HTTPException(404, { message: "Photo not found" });
  return { photo: p, role };
}

export async function getPhoto(db: Db, userId: string, photoId: string) {
  const { photo, role } = await photoWithRole(db, userId, photoId);
  const [c] = await db.select({ artist: concerts.artist, startsAt: concerts.startsAt, venue: concerts.venue }).from(concerts).where(eq(concerts.id, photo.concertId));
  const [r] = await withTags(db, userId, [{ ...photo, role, concert: c! }]);
  const { storageKey: _k, mime: _m, ...rest } = r!;
  return rest;
}

export async function updatePhoto(db: Db, userId: string, photoId: string, patch: { caption?: string | null; takenAt?: Date | null }) {
  const { role } = await photoWithRole(db, userId, photoId);
  if (!atLeast(role, "editor")) throw new HTTPException(403, { message: "Needs editor access" });
  await db.update(photos).set(patch).where(eq(photos.id, photoId));
}

/** Uploader or concert owner may delete. Removes the files too. */
export async function deletePhoto(db: Db, storage: Storage, userId: string, photoId: string) {
  const { photo, role } = await photoWithRole(db, userId, photoId);
  if (role !== "owner" && photo.uploaderId !== userId) throw new HTTPException(403, { message: "Only the uploader or the concert owner can delete this photo" });
  await db.delete(photos).where(eq(photos.id, photoId));
  await storage.deletePrefix(`photos/${photo.concertId}/${photo.id}.`);
}

export async function requirePhotosEditable(db: Db, userId: string, photoIds: string[]) {
  const unique = [...new Set(photoIds)];
  unique.forEach((id) => assertUuid(id, "Photo"));
  if (!unique.length) return [];
  const rows = await db
    .select({ id: photos.id, concertId: photos.concertId, role: concertMembers.role })
    .from(photos)
    .leftJoin(concertMembers, and(eq(concertMembers.concertId, photos.concertId), eq(concertMembers.userId, userId)))
    .where(inArray(photos.id, unique));
  if (rows.length !== unique.length || rows.some((r) => !r.role)) throw new HTTPException(404, { message: "Photo not found" });
  if (rows.some((r) => !atLeast(r.role, "editor"))) throw new HTTPException(403, { message: "Needs editor access" });
  return rows;
}

export { requireConcertRole };
