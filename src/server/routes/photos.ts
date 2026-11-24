import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { AppDeps } from "../app.js";
import { currentUser, type Env } from "../context.js";
import { concertRole } from "../access.js";
import { deletePhoto, getPhoto, keys, listPhotos, photoFilters, updatePhoto, uploadPhoto, usedBytes } from "../domain/photos.js";
import { verifyPhotoSignature, type Variant } from "../lib/signed-url.js";
import { photos } from "../db/schema.js";
import { eq } from "drizzle-orm";

const optDate = (v: string | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** /api routes for photos (session required). */
export function photoApiRoutes(deps: AppDeps) {
  const { db, storage, jobs, config } = deps;
  const r = new Hono<Env>();

  // One file per request, sent as the raw body (streamed straight to the photo volume).
  r.post("/concerts/:id/photos", async (c) => {
    const len = c.req.header("content-length");
    const caption = c.req.header("x-caption");
    const photo = await uploadPhoto({ db, storage, jobs, quotaBytes: config.STORAGE_QUOTA_BYTES }, currentUser(c).id, c.req.param("id"), c.req.raw.body, {
      contentLength: len ? Number(len) : undefined,
      takenAt: optDate(c.req.header("x-taken-at")),
      caption: caption ? decodeURIComponent(caption).slice(0, 500) : null,
    });
    return c.json({ id: photo.id, bytes: photo.bytes, thumbsReady: photo.thumbsReady }, 201);
  });

  r.get("/photos", async (c) => c.json(await listPhotos(db, currentUser(c).id, photoFilters.parse(c.req.query()))));
  r.get("/photos/:id", async (c) => c.json(await getPhoto(db, currentUser(c).id, c.req.param("id"))));
  r.patch("/photos/:id", async (c) => {
    const patch = z
      .object({ caption: z.string().max(500).nullable().optional(), takenAt: z.coerce.date().nullable().optional() })
      .parse(await c.req.json());
    await updatePhoto(db, currentUser(c).id, c.req.param("id"), patch);
    return c.body(null, 204);
  });
  r.delete("/photos/:id", async (c) => {
    await deletePhoto(db, storage, currentUser(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/me/usage", async (c) => c.json({ bytes: await usedBytes(db, currentUser(c).id), quota: config.STORAGE_QUOTA_BYTES }));
  return r;
}

const VARIANTS = ["thumb", "large", "original"] as const;

/**
 * GET /photos/:id/:variant – photo bytes after the same access check as the API,
 * or with a signed short-lived URL (MCP, email). Never exposes the volume directly.
 */
export function photoFileRoutes(deps: AppDeps) {
  const { db, storage, auth, config } = deps;
  const r = new Hono<Env>();
  r.get("/photos/:id/:variant", async (c) => {
    const id = c.req.param("id");
    const variant = c.req.param("variant") as Variant;
    if (!VARIANTS.includes(variant) || !/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
    const [p] = await db.select().from(photos).where(eq(photos.id, id));
    if (!p) return c.notFound();

    const signed = verifyPhotoSignature(config.BETTER_AUTH_SECRET, id, variant, c.req.query("exp"), c.req.query("sig"));
    if (!signed) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const user = session?.user as { id: string; disabled?: boolean } | undefined;
      if (!user || user.disabled || !(await concertRole(db, user.id, p.concertId))) return c.notFound();
    }

    const key = variant === "original" ? p.storageKey : variant === "thumb" ? keys.thumb(p.concertId, p.id) : keys.large(p.concertId, p.id);
    const file = await storage.stream(key);
    if (!file) throw new HTTPException(404, { message: variant === "original" ? "Photo file missing" : "Thumbnail not ready yet" });
    c.header("content-type", variant === "original" ? p.mime : "image/webp");
    c.header("content-length", String(file.size));
    c.header("cache-control", "private, max-age=86400");
    c.header("x-content-type-options", "nosniff");
    if (variant === "original") {
      const ext = p.mime.split("/")[1] === "jpeg" ? "jpg" : p.mime.split("/")[1];
      c.header("content-disposition", `attachment; filename="photo-${p.id.slice(0, 8)}.${ext}"`);
    }
    return stream(c, async (s) => {
      for await (const chunk of file.stream) await s.write(chunk as Uint8Array);
    });
  });
  return r;
}
