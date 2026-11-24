import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from "jose";
import { users } from "../src/server/db/schema.js";
import { appleClientSecret, OTP_ATTEMPTS } from "../src/server/auth.js";
import {
  as,
  codeFrom,
  cookieHeader,
  freshIp,
  requestCode,
  resetDb,
  signIn,
  signInWithCode,
  testConfig,
  testServices,
} from "./helpers.js";

const s = await testServices({}, { otpLimits: { perEmail: 5, perIp: 20 } });
afterAll(() => s.close());
beforeEach(async () => {
  await resetDb(s.db);
  vi.useRealTimers();
});

describe("email login code", () => {
  it("mails a 6-digit code and signs in with it", async () => {
    const res = await requestCode(s, "anna@example.com");
    expect(res.status).toBe(200);
    const code = codeFrom(s, "anna@example.com");
    expect(code).toMatch(/^\d{6}$/);

    const r = await signInWithCode(s, "anna@example.com", code);
    expect(r.status).toBe(200);
    const me = await as(s, cookieHeader(r)).get("/api/me");
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("anna@example.com");
  });

  it("signing in twice with the same email gives the same account", async () => {
    await signIn(s, "bob@example.com");
    await signIn(s, "bob@example.com");
    const rows = await s.db.select().from(users).where(eq(users.email, "bob@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("rejects a wrong code and locks the code after the allowed attempts", async () => {
    await requestCode(s, "carl@example.com");
    const code = codeFrom(s, "carl@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_ATTEMPTS; i++) {
      const r = await signInWithCode(s, "carl@example.com", wrong);
      expect(r.status).not.toBe(200);
    }
    const r = await signInWithCode(s, "carl@example.com", code);
    expect(r.status).not.toBe(200);
  });

  it("rejects a code after 10 minutes", async () => {
    await requestCode(s, "dana@example.com");
    const code = codeFrom(s, "dana@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);
    const r = await signInWithCode(s, "dana@example.com", code);
    expect(r.status).not.toBe(200);
  });

  it("still accepts a code just before 10 minutes", async () => {
    await requestCode(s, "gina@example.com");
    const code = codeFrom(s, "gina@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    const r = await signInWithCode(s, "gina@example.com", code);
    expect(r.status).toBe(200);
  });

  it("refuses disposable email domains", async () => {
    const res = await requestCode(s, "x@mailinator.com");
    expect(res.status).toBe(400);
    expect(s.mailer.last("x@mailinator.com")).toBeUndefined();
  });

  it("rate-limits code requests per email", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestCode(s, "eve@example.com", freshIp())).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it("rate-limits code requests per IP", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await requestCode(s, `ip${i}@example.com`, ip)).status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(20);
    expect(statuses[20]).toBe(429);
  });

  it("refuses sign-in for a disabled account", async () => {
    await signIn(s, "frank@example.com");
    await s.db.update(users).set({ disabled: true }).where(eq(users.email, "frank@example.com"));
    await expect(signIn(s, "frank@example.com")).rejects.toThrow(/sign in failed: 403/);
  });
});

describe("session", () => {
  it("/api/me needs a session", async () => {
    expect((await s.app.request("/api/me")).status).toBe(401);
  });

  it("exposes only fully configured SSO providers", async () => {
    const t = await testServices({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GOOGLE_CLIENT_ID: "g" });
    const body = await (await t.app.request("/api/config")).json();
    expect(body.providers).toEqual(["github"]);
    await t.close();
  });
});

describe("apple client secret", () => {
  it("is an ES256 JWT for the team/services id that expires within 6 months", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = testConfig({
      APPLE_CLIENT_ID: "nl.gekophetweb.atcgang",
      APPLE_TEAM_ID: "TEAM123",
      APPLE_KEY_ID: "KEY123",
      APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    });
    const jwt = (await appleClientSecret(config))!;
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "KEY123" });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ iss: "TEAM123", sub: "nl.gekophetweb.atcgang", aud: "https://appleid.apple.com" });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(183 * 24 * 3600);
  });

  it("is undefined when Apple isn't configured", async () => {
    expect(await appleClientSecret(testConfig())).toBeUndefined();
  });
});
