import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha, emailOTP, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { importPKCS8, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import * as schema from "./db/schema.js";
import type { Mailer } from "./lib/mailer.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { clientIp } from "./lib/client-ip.js";
import { isDisposableEmail } from "./lib/disposable-email.js";
import { loginCodeMail } from "./mail-templates.js";

export const OTP_EXPIRES_SECONDS = 600;
export const OTP_ATTEMPTS = 5;
const SEND_OTP_PATH = "/email-otp/send-verification-otp";

export interface AuthDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  /** Extra Better Auth plugins (MCP provider is added in createAuth when enabled). */
  extraPlugins?: BetterAuthOptions["plugins"];
  /** Apple client secret, generated from the .p8 key at startup (see appleClientSecret). */
  appleClientSecret?: string;
  /** Login-code send limits per hour (tests raise them). */
  otpLimits?: { perEmail: number; perIp: number };
}

/** Apple's client secret is a JWT that may live at most 6 months; build it from the key instead of storing it. */
export async function appleClientSecret(config: Config, now = new Date()): Promise<string | undefined> {
  const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = config;
  if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) return undefined;
  const key = await importPKCS8(APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "ES256");
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setSubject(APPLE_CLIENT_ID)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 180 * 24 * 3600)
    .sign(key);
}

function socialProviders(config: Config, appleSecret?: string): BetterAuthOptions["socialProviders"] {
  const p: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    p.google = { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET, prompt: "select_account" };
  }
  if (config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET) {
    p.microsoft = {
      clientId: config.MICROSOFT_CLIENT_ID,
      clientSecret: config.MICROSOFT_CLIENT_SECRET,
      tenantId: "common",
      prompt: "select_account",
    };
  }
  if (config.APPLE_CLIENT_ID && appleSecret) {
    p.apple = {
      clientId: config.APPLE_CLIENT_ID,
      clientSecret: appleSecret,
      appBundleIdentifier: config.APPLE_APP_BUNDLE_IDENTIFIER,
    };
  }
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) {
    p.github = { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET, scope: ["user:email"] };
  }
  return p;
}

export const mcpResource = (config: Config) => `${config.BASE_URL}/mcp`;

export function enabledProviders(config: Config, appleSecret?: string): string[] {
  return Object.keys(socialProviders(config, appleSecret) ?? {});
}

export function createAuth(deps: AuthDeps) {
  const { config, db, mailer } = deps;
  const limits = deps.otpLimits ?? { perEmail: 5, perIp: 20 };
  const perEmail = new RateLimiter(limits.perEmail, 60 * 60 * 1000);
  const perIp = new RateLimiter(limits.perIp, 60 * 60 * 1000);

  const plugins: NonNullable<BetterAuthOptions["plugins"]> = [
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_EXPIRES_SECONDS,
      allowedAttempts: OTP_ATTEMPTS,
      storeOTP: "hashed",
      async sendVerificationOTP({ email, otp }) {
        await mailer.send(loginCodeMail(email, otp));
      },
    }),
    ...(config.TURNSTILE_SECRET_KEY
      ? [
          captcha({
            provider: "cloudflare-turnstile",
            secretKey: config.TURNSTILE_SECRET_KEY,
            endpoints: [SEND_OTP_PATH],
          }),
        ]
      : []),
    // MCP: this app is the OAuth 2.1 authorization server for its own /mcp endpoint.
    jwt(),
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource: mcpResource(config),
      // Older MCP clients register themselves dynamically; newer ones use Client ID Metadata Documents.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ...(deps.extraPlugins ?? []),
  ];

  return betterAuth({
    baseURL: config.BASE_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.BASE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    user: {
      additionalFields: {
        role: { type: "string", input: false, defaultValue: "user" },
        emailNotifications: { type: "boolean", input: true, defaultValue: true },
        disabled: { type: "boolean", input: false, defaultValue: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    account: {
      accountLinking: {
        enabled: true,
        // Providers that only hand out verified emails link to an existing account with the same email.
        // GitHub is not listed: its email is only linked when it is the primary *verified* address.
        trustedProviders: ["google", "microsoft", "apple", "email-otp"],
        // Linking from Settings while signed in may use a different email (Apple "Hide My Email").
        allowDifferentEmails: true,
      },
    },
    socialProviders: socialProviders(config, deps.appleClientSecret),
    rateLimit: {
      enabled: config.NODE_ENV !== "test",
      window: 60,
      max: 100,
      customRules: { [SEND_OTP_PATH]: { window: 60, max: 3 }, "/sign-in/email-otp": { window: 60, max: 10 } },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: config.TRUST_CF_HEADERS ? ["cf-connecting-ip"] : ["x-forwarded-for"] },
      useSecureCookies: config.BASE_URL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_OTP_PATH) return;
        const email = String((ctx.body as { email?: string } | undefined)?.email ?? "").toLowerCase().trim();
        if (isDisposableEmail(email)) {
          throw new APIError("BAD_REQUEST", { message: "Please use a non-disposable email address." });
        }
        const ip = ctx.request ? clientIp(ctx.request.headers, config.TRUST_CF_HEADERS) : "unknown";
        if (!perEmail.hit(`email:${email}`) || !perIp.hit(`ip:${ip}`)) {
          throw new APIError("TOO_MANY_REQUESTS", { message: "Too many login codes requested. Try again later." });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Email-code sign-ups have no name yet: start with the part before the @.
          async before(user) {
            return { data: { ...user, name: user.name?.trim() || user.email.split("@")[0]! } };
          },
        },
      },
      session: {
        create: {
          async before(session) {
            const [u] = await db
              .select({ disabled: schema.users.disabled })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId));
            if (u?.disabled) throw new APIError("FORBIDDEN", { message: "This account has been disabled." });
          },
        },
      },
    },
    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
