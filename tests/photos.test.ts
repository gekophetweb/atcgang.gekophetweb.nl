import { afterAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { existsSync } from "node:fs";
import path from "node:path";
import { signPhotoUrl } from "../src/server/lib/signed-url.js";
import { keys, sniffMime } from "../src/server/domain/photos.js";
import { jpeg, resetDb, testServices, upload, user, type TestServices } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(() => resetDb(s.db));


async function concertOf(u: Awaited<ReturnType<typeof user>>) {
  return (await (await u.api.post("/api/concerts", { artist: "Foo Fighters", startsAt: "2026-06-01T19:00:00Z" })).json()) as { id: string };
}

const photoPath = (svc: TestServices, key: string) => path.join(svc.config.PHOTO_DIR, key);

describe("magic bytes", () => {
  it("recognises JPEG, PNG and WebP and nothing else", async () => {
    expect(sniffMime(await jpeg(10, 10))).toBe("image/jpeg");
    expect(sniffMime(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer())).toBe("image/png");
    expect(sniffMime(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).webp().toBuffer())).toBe("image/webp");
    expect(sniffMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffMime(Buffer.from("GIF89a......"))).toBeNull();
  });
});

describe("upload and thumbnails", () => {
  it("stores the original, queues thumbnails and fills in size + EXIF-less date", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertOf(anna);
    const res = await upload(s, anna, c.id, await jpeg(), { "x-taken-at": "2026-06-01T21:15:00Z" });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    let list = await (await anna.api.get(`/api/photos?concert=${c.id}`)).json();
    expect(list[0]).toMatchObject({ id, thumbsReady: false, takenAt: "2026-06-01T21:15:00.000Z" });
    expect((await anna.api.get(`/photos/${id}/thumb`)).status).toBe(404);

    await s.jobs.drain();
    list = await (await anna.api.get(`/api/photos?concert=${c.id}`)).json();
    expect(list[0]).toMatchObject({ thumbsReady: true, width: 1200, height: 800 });

    const thumb = await anna.api.get(`/photos/${id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=86400");
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.min(meta.width!, meta.height!)).toBe(400);
    const large = await sharp(Buffer.from(await (await anna.api.get(`/photos/${id}/large`)).arrayBuffer())).metadata();
    expect(Math.max(large.width!, large.height!)).toBe(1200); // never enlarged past the original

    const orig = await anna.api.get(`/photos/${id}/original`);
    expect(orig.headers.get("content-type")).toBe("image/jpeg");
    expect(orig.headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses files that aren't JPEG/PNG/WebP regardless of the content type", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertOf(anna);
    const res = await upload(s, anna, c.id, Buffer.from("<html><script>alert(1)</script></html>"));
    expect(res.status).toBe(415);
  });

  it("refuses files over 25 MB up front", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertOf(anna);
    const res = await upload(s, anna, c.id, await jpeg(10, 10), { "content-length": String(26 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("enforces the storage quota, also when the length isn't announced", async () => {
    const small = await testServices({ STORAGE_QUOTA_BYTES: "30000" });
    try {
      const anna = await user(small, "anna@example.com");
      const c = await concertOf(anna);
      const big = await jpeg(1200, 800);
      expect(big.length).toBeGreaterThan(5000);
      expect((await upload(small, anna, c.id, big, { "content-length": String(40000) })).status).toBe(507);
      // Stream without content-length: cut off while writing, nothing left on disk.
      const noisy = await sharp(Buffer.alloc(300 * 300 * 3).map(() => Math.floor(Math.random() * 256)), { raw: { width: 300, height: 300, channels: 3 } })
        .jpeg({ quality: 100 })
        .toBuffer();
      expect(noisy.length).toBeGreaterThan(30000);
      const res = await small.app.request(`/api/concerts/${c.id}/photos`, {
        method: "POST",
        headers: { cookie: anna.cookie, origin: "http://localhost:3000" },
        body: new Blob([noisy]).stream(),
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(507);
      expect(await (await anna.api.get("/api/photos")).json()).toEqual([]);
      const usage = await (await anna.api.get("/api/me/usage")).json();
      expect(usage).toEqual({ bytes: 0, quota: 30000 });
    } finally {
      await small.close();
    }
  });

  it("viewers can't upload; strangers can't see or fetch photos", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const c = await concertOf(anna);
    const { id } = await (await upload(s, anna, c.id, await jpeg())).json();
    await s.jobs.drain();
    expect((await upload(s, bob, c.id, await jpeg())).status).toBe(404);
    expect((await bob.api.get(`/photos/${id}/thumb`)).status).toBe(404);
    expect((await s.app.request(`/photos/${id}/thumb`)).status).toBe(404);
    expect(await (await bob.api.get("/api/photos")).json()).toEqual([]);

    const inv = await (await anna.api.post(`/api/concerts/${c.id}/invites`, { role: "viewer" })).json();
    await bob.api.post(`/api/invites/${inv.url.split("/invite/")[1]}/accept`);
    expect((await bob.api.get(`/photos/${id}/thumb`)).status).toBe(200);
    expect((await upload(s, bob, c.id, await jpeg())).status).toBe(403);
  });

  it("signed URLs work without a session until they expire", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertOf(anna);
    const { id } = await (await upload(s, anna, c.id, await jpeg())).json();
    await s.jobs.drain();
    const url = new URL(signPhotoUrl(s.config.BASE_URL, s.config.BETTER_AUTH_SECRET, id, "thumb", 60));
    expect((await s.app.request(url.pathname + url.search)).status).toBe(200);
    // Signature is bound to the variant.
    expect((await s.app.request(url.pathname.replace("thumb", "original") + url.search)).status).toBe(404);
    const old = new URL(signPhotoUrl(s.config.BASE_URL, s.config.BETTER_AUTH_SECRET, id, "thumb", 60, Date.now() - 3600_000));
    expect((await s.app.request(old.pathname + old.search)).status).toBe(404);
  });
});

describe("delete", () => {
  it("uploader or owner deletes a photo and its files", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const carl = await user(s, "carl@example.com");
    const c = await concertOf(anna);
    for (const u of [bob, carl]) {
      const inv = await (await anna.api.post(`/api/concerts/${c.id}/invites`, {})).json();
      await u.api.post(`/api/invites/${inv.url.split("/invite/")[1]}/accept`);
    }
    const { id } = await (await upload(s, bob, c.id, await jpeg())).json();
    await s.jobs.drain();
    expect(existsSync(photoPath(s, keys.thumb(c.id, id)))).toBe(true);
    expect((await carl.api.del(`/api/photos/${id}`)).status).toBe(403);
    expect((await bob.api.del(`/api/photos/${id}`)).status).toBe(204);
    expect(existsSync(photoPath(s, keys.original(c.id, id)))).toBe(false);
    expect(existsSync(photoPath(s, keys.thumb(c.id, id)))).toBe(false);
  });

  it("deleting a concert removes all of its photo files", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertOf(anna);
    const { id } = await (await upload(s, anna, c.id, await jpeg())).json();
    await s.jobs.drain();
    expect((await anna.api.del(`/api/concerts/${c.id}`)).status).toBe(204);
    expect(existsSync(photoPath(s, keys.original(c.id, id)))).toBe(false);
    expect(existsSync(path.join(s.config.PHOTO_DIR, "photos", c.id))).toBe(false);
  });
});
