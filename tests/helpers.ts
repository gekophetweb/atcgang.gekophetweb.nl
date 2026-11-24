import { sql } from "drizzle-orm";
import sharp from "sharp";
import { loadConfig, type Config } from "../src/server/config.js";
import { createServices, type Services, type ServiceOverrides } from "../src/server/services.js";
import { MemoryMailer } from "../src/server/lib/mailer.js";
import { ManualJobs } from "../src/server/lib/jobs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../src/server/db/client.js";

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BASE_URL: "http://localhost:3000",
    CLIENT_DIR: "./tests/fixtures/client",
    PHOTO_DIR: "./.superpowers/test-photos",
    TRUST_CF_HEADERS: "true",
    ...overrides,
  });
}

export type TestServices = Services & { mailer: MemoryMailer; jobs: ManualJobs };

export async function testServices(
  overrides: Partial<Record<string, string>> = {},
  serviceOverrides: Omit<ServiceOverrides, "mailer"> = {},
): Promise<TestServices> {
  const mailer = new MemoryMailer();
  const jobs = new ManualJobs();
  const photoDir = mkdtempSync(path.join(tmpdir(), "atc-photos-"));
  const s = await createServices(testConfig({ PHOTO_DIR: photoDir, ...overrides }), {
    jobs,
    otpLimits: { perEmail: 10_000, perIp: 10_000 },
    ...serviceOverrides,
    mailer,
  });
  return s as TestServices;
}

/** Empties every table in the public schema, except state the auth server seeds once per process. */
export async function resetDb(db: Db) {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('oauth_resource', 'jwks')`,
  );
  const names = rows.map((r) => `"${r.tablename}"`);
  if (names.length) await db.execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
}

let ipCounter = 0;
/** A fresh fake client IP so per-IP limits don't bleed between tests. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  };
}

export async function requestCode(s: TestServices, email: string, ip = freshIp()) {
  return s.app.request(
    "/api/auth/email-otp/send-verification-otp",
    json({ email, type: "sign-in" }, { "cf-connecting-ip": ip }),
  );
}

export function codeFrom(s: TestServices, email: string): string {
  const mail = s.mailer.last(email);
  const m = mail?.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no code mailed to ${email}`);
  return m[1]!;
}

export async function signInWithCode(s: TestServices, email: string, otp: string, ip = freshIp()) {
  return s.app.request("/api/auth/sign-in/email-otp", json({ email, otp }, { "cf-connecting-ip": ip }));
}

export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Full email-code sign-in; returns a Cookie header value for authenticated requests. */
export async function signIn(s: TestServices, email: string): Promise<string> {
  const sent = await requestCode(s, email);
  if (sent.status !== 200) throw new Error(`send code failed: ${sent.status} ${await sent.text()}`);
  const res = await signInWithCode(s, email, codeFrom(s, email));
  if (res.status !== 200) throw new Error(`sign in failed: ${res.status} ${await res.text()}`);
  return cookieHeader(res);
}

/** Request helper bound to a session cookie. */
export function as(s: TestServices, cookie: string) {
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    s.app.request(path, {
      method,
      headers: {
        cookie,
        origin: "http://localhost:3000",
        ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
    put: (p: string, b: unknown) => call("PUT", p, b),
    del: (p: string, b?: unknown) => call("DELETE", p, b),
    raw: call,
  };
}

/** Signs in a user and returns their id plus a bound client. */
export async function user(s: TestServices, email: string) {
  const cookie = await signIn(s, email);
  const me = await (await as(s, cookie).get("/api/me")).json();
  return { id: me.user.id as string, email, cookie, api: as(s, cookie) };
}

export async function jpeg(w = 1200, h = 800) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 20 } } })
    .jpeg()
    .toBuffer();
}

export async function upload(svc: TestServices, u: { cookie: string }, concertId: string, body: Buffer, headers: Record<string, string> = {}) {
  return svc.app.request(`/api/concerts/${concertId}/photos`, {
    method: "POST",
    headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "image/jpeg", "content-length": String(body.length), ...headers },
    body: new Uint8Array(body),
  });
}

