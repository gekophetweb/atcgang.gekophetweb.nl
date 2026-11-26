import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { appSettings, concerts, users } from "../src/server/db/schema.js";
import { keys } from "../src/server/domain/photos.js";
import { ConsoleMailer, MailgunMailer, mailerFor, ResendMailer, SmtpMailer } from "../src/server/lib/mailer.js";
import { decrypt, encrypt, mailSettingsSchema } from "../src/server/settings.js";
import { jpeg, resetDb, testServices, upload, user } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(async () => {
  await resetDb(s.db);
  await s.settings.load();
});

const concertFor = async (u: Awaited<ReturnType<typeof user>>, over: Record<string, unknown> = {}) =>
  (await (await u.api.post("/api/concerts", { artist: "Foo Fighters", startsAt: "2026-06-01T19:00:00Z", ...over })).json()) as { id: string };

async function share(owner: Awaited<ReturnType<typeof user>>, guest: Awaited<ReturnType<typeof user>>, id: string, role = "editor") {
  const inv = await (await owner.api.post(`/api/concerts/${id}/invites`, { role })).json();
  await guest.api.post(`/api/invites/${inv.url.split("/invite/")[1]}/accept`);
}

describe("admin", () => {
  it("makes the first account admin; later accounts are normal users", async () => {
    const first = await user(s, "first@example.com");
    const second = await user(s, "second@example.com");
    expect((await (await first.api.get("/api/me")).json()).user.role).toBe("admin");
    expect((await (await second.api.get("/api/me")).json()).user.role).toBe("user");
  });

  it("lets admins see all users, disable them and grant admin; others get 403", async () => {
    const admin = await user(s, "admin@example.com");
    const bob = await user(s, "bob@example.com");
    expect((await bob.api.get("/api/admin/overview")).status).toBe(403);
    const o = await (await admin.api.get("/api/admin/overview")).json();
    expect(o.users.map((u: { email: string }) => u.email).sort()).toEqual(["admin@example.com", "bob@example.com"]);
    expect(o.totals.users).toBe(2);

    expect((await admin.api.patch(`/api/admin/users/${bob.id}`, { disabled: true })).status).toBe(204);
    expect((await bob.api.get("/api/me")).status).toBe(401);
    expect((await admin.api.patch(`/api/admin/users/${admin.id}`, { disabled: true })).status).toBe(400);
    expect((await admin.api.patch(`/api/admin/users/${admin.id}`, { role: "user" })).status).toBe(400);

    await admin.api.patch(`/api/admin/users/${bob.id}`, { disabled: false, role: "admin" });
    const bob2 = await user(s, "bob@example.com");
    expect((await bob2.api.get("/api/admin/overview")).status).toBe(200);
  });
});

describe("site settings", () => {
  it("stores mail settings with encrypted secrets and never returns them", async () => {
    const admin = await user(s, "admin@example.com");
    const bob = await user(s, "bob@example.com");
    expect((await bob.api.put("/api/admin/settings/mail", { provider: "console", from: "x@y.z" })).status).toBe(403);

    const res = await admin.api.put("/api/admin/settings/mail", {
      provider: "mailgun",
      from: "ATC <noreply@example.com>",
      mailgunApiKey: "key-secret-123",
      mailgunDomain: "mg.example.com",
      mailgunRegion: "eu",
    });
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.mail).toMatchObject({ provider: "mailgun", mailgunDomain: "mg.example.com", mailgunApiKeySet: true });
    expect(JSON.stringify(view)).not.toContain("key-secret-123");

    const [row] = await s.db.select().from(appSettings).where(eq(appSettings.key, "mail"));
    expect(String(row!.value.mailgunApiKey)).toMatch(/^enc:/);

    // Saving again without the secret keeps it.
    await admin.api.put("/api/admin/settings/mail", { provider: "mailgun", from: "ATC <noreply@example.com>", mailgunDomain: "mg2.example.com" });
    expect(s.settings.mail.mailgunApiKey).toBe("key-secret-123");
    expect(s.settings.mail.mailgunDomain).toBe("mg2.example.com");
    // And it survives a reload from the database.
    await s.settings.load();
    expect(s.settings.mail.mailgunApiKey).toBe("key-secret-123");
  });

  it("sends a test email to the admin", async () => {
    const admin = await user(s, "admin@example.com");
    const res = await admin.api.post("/api/admin/settings/mail/test");
    expect(await res.json()).toEqual({ ok: true, to: "admin@example.com" });
    expect(s.mailer.last("admin@example.com")?.subject).toBe("ATC Gang test email");
  });

  it("turns SSO providers on and off without a restart", async () => {
    const admin = await user(s, "admin@example.com");
    expect((await (await s.app.request("/api/config")).json()).providers).toEqual([]);
    const sso = {
      google: { enabled: true, clientId: "g-id", clientSecret: "g-secret" },
      github: { enabled: true, clientId: "gh-id" }, // no secret yet → not offered
    };
    const res = await admin.api.put("/api/admin/settings/sso", sso);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sso.google).toMatchObject({ enabled: true, clientId: "g-id", clientSecretSet: true, ready: true });
    expect(body.sso.github.ready).toBe(false);
    expect(body.callbackUrls.google).toBe("http://localhost:3000/api/auth/callback/google");
    expect((await (await s.app.request("/api/config")).json()).providers).toEqual(["google"]);

    // The rebuilt auth instance still knows existing sessions.
    expect((await admin.api.get("/api/me")).status).toBe(200);
    // Social sign-in now redirects to Google.
    const signin = await s.app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    });
    expect((await signin.json()).url).toContain("accounts.google.com");

    await admin.api.put("/api/admin/settings/sso", { google: { enabled: false, clientId: "g-id" } });
    expect((await (await s.app.request("/api/config")).json()).providers).toEqual([]);
    expect(s.settings.sso.google.clientSecret).toBe("g-secret");
  });

  it("accepts Apple's form_post callback from appleid.apple.com", async () => {
    const admin = await user(s, "admin@example.com");
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await admin.api.put("/api/admin/settings/sso", { apple: { enabled: true, clientId: "nl.example.web", teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem } });
    expect((await (await s.app.request("/api/config")).json()).providers).toEqual(["apple"]);
    // Apple POSTs cross-site; a browser that still has a session cookie sends it along.
    const res = await s.app.request("/api/auth/callback/apple", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com", cookie: admin.cookie },
      body: "code=abc&state=xyz",
    });
    expect(res.status).toBe(302);
  });

  it("encrypts with the app secret and builds the right mailer", () => {
    const enc = encrypt("secret-a", "hello");
    expect(decrypt("secret-a", enc)).toBe("hello");
    expect(() => decrypt("secret-b", enc)).toThrow();
    const m = (o: Record<string, unknown>) => mailerFor(mailSettingsSchema.parse({ from: "a@b.c", ...o }));
    expect(m({ provider: "resend", resendApiKey: "re_x" })).toBeInstanceOf(ResendMailer);
    expect(m({ provider: "mailgun", mailgunApiKey: "k", mailgunDomain: "d" })).toBeInstanceOf(MailgunMailer);
    expect(m({ provider: "smtp", smtpHost: "smtp.example.com" })).toBeInstanceOf(SmtpMailer);
    expect(m({ provider: "mailgun" })).toBeInstanceOf(ConsoleMailer);
  });
});

describe("concert merge", () => {
  it("moves photos, people and notes into the shared concert and deletes the duplicate", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const shared = await concertFor(anna, { notes: "Anna's notes" });
    const own = await concertFor(bob, { notes: "Bob's notes" });
    const { id: photoId } = await (await upload(s, bob, own.id, await jpeg())).json();
    await s.jobs.drain();
    const zoe = await (await bob.api.post("/api/people", { name: "Zoe" })).json();
    await bob.api.put(`/api/concerts/${own.id}/people`, { personIds: [zoe.id] });
    await share(anna, bob, shared.id);

    expect((await bob.api.post(`/api/concerts/${own.id}/merge-into/${shared.id}`)).status).toBe(200);
    expect((await bob.api.get(`/api/concerts/${own.id}`)).status).toBe(404);
    const detail = await (await bob.api.get(`/api/concerts/${shared.id}`)).json();
    expect(detail.photoCount).toBe(1);
    expect(detail.people.map((p: { name: string }) => p.name)).toEqual(["Zoe"]);
    expect(detail.notes).toBe("Anna's notes\n\nBob's notes");
    expect((await anna.api.get(`/photos/${photoId}/thumb`)).status).toBe(200);
    expect(existsSync(path.join(s.config.PHOTO_DIR, keys.original(shared.id, photoId)))).toBe(true);

    // Only the duplicate's owner may merge it.
    const other = await concertFor(anna);
    expect((await bob.api.post(`/api/concerts/${other.id}/merge-into/${shared.id}`)).status).toBe(404);
  });
});

describe("export and account deletion", () => {
  it("exports JSON plus uploaded photos as a zip", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await concertFor(anna);
    await upload(s, anna, c.id, await jpeg());
    const res = await anna.api.get("/api/export");
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.includes(Buffer.from("data.json"))).toBe(true);
    expect(buf.includes(Buffer.from("photos/"))).toBe(true);
  });

  it("locks the account at once, then hands shared concerts over and deletes the rest", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const shared = await concertFor(anna, { artist: "Shared" });
    const solo = await concertFor(anna, { artist: "Solo" });
    await share(anna, bob, shared.id);
    const { id: soloPhoto } = await (await upload(s, anna, solo.id, await jpeg())).json();
    const { id: sharedPhoto } = await (await upload(s, anna, shared.id, await jpeg())).json();
    await s.jobs.drain();

    expect((await anna.api.del("/api/me", { confirm: "nope" })).status).toBe(400);
    expect((await anna.api.del("/api/me", { confirm: "DELETE" })).status).toBe(202);
    expect((await anna.api.get("/api/me")).status).toBe(401);
    await s.jobs.drain();

    expect(await s.db.select().from(users).where(eq(users.id, anna.id))).toEqual([]);
    const [kept] = await s.db.select().from(concerts).where(eq(concerts.id, shared.id));
    expect(kept!.ownerId).toBe(bob.id);
    expect((await (await bob.api.get(`/api/concerts/${shared.id}`)).json()).myRole).toBe("owner");
    expect(await s.db.select().from(concerts).where(eq(concerts.id, solo.id))).toEqual([]);
    // Anna's photos are gone, files included – also in the concert that lives on.
    expect(existsSync(path.join(s.config.PHOTO_DIR, keys.original(solo.id, soloPhoto)))).toBe(false);
    expect(existsSync(path.join(s.config.PHOTO_DIR, keys.original(shared.id, sharedPhoto)))).toBe(false);
    expect((await (await bob.api.get(`/api/concerts/${shared.id}`)).json()).photoCount).toBe(0);
  });
});
