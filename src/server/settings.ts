import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { appSettings } from "./db/schema.js";

// ---------------------------------------------------------------------------
// Admin-editable settings (mail provider, SSO credentials). Stored in the DB with
// secrets encrypted; values from .env are the fallback until an admin saves settings.
// ---------------------------------------------------------------------------

export const MAIL_PROVIDERS = ["console", "resend", "mailgun", "smtp"] as const;
export const SSO_PROVIDERS = ["google", "microsoft", "apple", "github"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export const mailSettingsSchema = z.object({
  provider: z.enum(MAIL_PROVIDERS),
  from: z.string().trim().min(3).max(200),
  resendApiKey: z.string().optional(),
  mailgunApiKey: z.string().optional(),
  mailgunDomain: z.string().trim().optional(),
  mailgunRegion: z.enum(["us", "eu"]).default("eu"),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;

const ssoEntry = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().optional(),
  // Apple only
  teamId: z.string().trim().optional(),
  keyId: z.string().trim().optional(),
  privateKey: z.string().optional(),
});
export const ssoSettingsSchema = z.object({
  google: ssoEntry.default({ enabled: false }),
  microsoft: ssoEntry.default({ enabled: false }),
  apple: ssoEntry.default({ enabled: false }),
  github: ssoEntry.default({ enabled: false }),
});
export type SsoSettings = z.infer<typeof ssoSettingsSchema>;
export type SsoEntry = z.infer<typeof ssoEntry>;

const MAIL_SECRETS = ["resendApiKey", "mailgunApiKey", "smtpPassword"] as const;
const SSO_SECRETS = ["clientSecret", "privateKey"] as const;

// --- encryption (AES-256-GCM, key derived from BETTER_AUTH_SECRET) ----------

const keyFrom = (secret: string) => createHash("sha256").update(`atcgang-settings:${secret}`).digest();

export function encrypt(secret: string, plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")}`;
}

export function decrypt(secret: string, value: string) {
  if (!value.startsWith("enc:")) return value;
  const buf = Buffer.from(value.slice(4), "base64");
  const d = createDecipheriv("aes-256-gcm", keyFrom(secret), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// --- defaults from .env -------------------------------------------------------

export function mailFromEnv(config: Config): MailSettings {
  return mailSettingsSchema.parse({
    provider: config.RESEND_API_KEY ? "resend" : "console",
    from: config.MAIL_FROM,
    resendApiKey: config.RESEND_API_KEY,
  });
}

export function ssoFromEnv(config: Config): SsoSettings {
  const both = (a?: string, b?: string) => !!a && !!b;
  return ssoSettingsSchema.parse({
    google: { enabled: both(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET), clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET },
    microsoft: {
      enabled: both(config.MICROSOFT_CLIENT_ID, config.MICROSOFT_CLIENT_SECRET),
      clientId: config.MICROSOFT_CLIENT_ID,
      clientSecret: config.MICROSOFT_CLIENT_SECRET,
    },
    apple: {
      enabled: !!(config.APPLE_CLIENT_ID && config.APPLE_TEAM_ID && config.APPLE_KEY_ID && config.APPLE_PRIVATE_KEY),
      clientId: config.APPLE_CLIENT_ID,
      teamId: config.APPLE_TEAM_ID,
      keyId: config.APPLE_KEY_ID,
      privateKey: config.APPLE_PRIVATE_KEY,
    },
    github: { enabled: both(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET), clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET },
  });
}

/** Whether a provider has everything it needs to be offered on the sign-in page. */
export function ssoReady(p: SsoProvider, e: SsoEntry) {
  if (!e.enabled || !e.clientId) return false;
  return p === "apple" ? !!(e.teamId && e.keyId && e.privateKey) : !!e.clientSecret;
}

// --- store --------------------------------------------------------------------

type Listener = () => void | Promise<void>;

export class SettingsStore {
  private mailValue: MailSettings;
  private ssoValue: SsoSettings;
  private listeners: Listener[] = [];

  constructor(
    private db: Db,
    private config: Config,
  ) {
    this.mailValue = mailFromEnv(config);
    this.ssoValue = ssoFromEnv(config);
  }

  get mail() {
    return this.mailValue;
  }
  get sso() {
    return this.ssoValue;
  }

  onChange(l: Listener) {
    this.listeners.push(l);
  }

  async load() {
    const rows = await this.db.select().from(appSettings);
    for (const r of rows) {
      if (r.key === "mail") this.mailValue = mailSettingsSchema.parse(this.decryptMail(r.value as Record<string, unknown>));
      if (r.key === "sso") this.ssoValue = ssoSettingsSchema.parse(this.decryptSso(r.value as Record<string, Record<string, unknown>>));
    }
  }

  /** Saves mail settings. Secret fields left empty keep their current value. */
  async saveMail(input: unknown) {
    const patch = mailSettingsSchema.parse(input);
    for (const k of MAIL_SECRETS) if (!patch[k]) patch[k] = this.mailValue[k];
    this.mailValue = patch;
    const stored: Record<string, unknown> = { ...patch };
    for (const k of MAIL_SECRETS) if (patch[k]) stored[k] = encrypt(this.config.BETTER_AUTH_SECRET, patch[k]!);
    await this.write("mail", stored);
  }

  async saveSso(input: unknown) {
    const next = ssoSettingsSchema.parse(input);
    const stored: Record<string, Record<string, unknown>> = {};
    for (const p of SSO_PROVIDERS) {
      for (const k of SSO_SECRETS) if (!next[p][k]) next[p][k] = this.ssoValue[p][k];
      stored[p] = { ...next[p] };
      for (const k of SSO_SECRETS) if (next[p][k]) stored[p][k] = encrypt(this.config.BETTER_AUTH_SECRET, next[p][k]!);
    }
    this.ssoValue = next;
    await this.write("sso", stored);
  }

  /** What the admin page sees: secrets are never sent back, only whether one is set. */
  publicView() {
    const mail: Record<string, unknown> = { ...this.mailValue };
    for (const k of MAIL_SECRETS) {
      mail[`${k}Set`] = !!this.mailValue[k];
      delete mail[k];
    }
    const sso: Record<string, Record<string, unknown>> = {};
    for (const p of SSO_PROVIDERS) {
      const e: Record<string, unknown> = { ...this.ssoValue[p], ready: ssoReady(p, this.ssoValue[p]) };
      for (const k of SSO_SECRETS) {
        e[`${k}Set`] = !!this.ssoValue[p][k];
        delete e[k];
      }
      sso[p] = e;
    }
    return { mail, sso, callbackUrls: Object.fromEntries(SSO_PROVIDERS.map((p) => [p, `${this.config.BASE_URL}/api/auth/callback/${p}`])) };
  }

  private async write(key: "mail" | "sso", value: Record<string, unknown>) {
    await this.db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    for (const l of this.listeners) await l();
  }

  private decryptMail(v: Record<string, unknown>) {
    const out = { ...v };
    for (const k of MAIL_SECRETS) if (typeof out[k] === "string") out[k] = decrypt(this.config.BETTER_AUTH_SECRET, out[k] as string);
    return out;
  }

  private decryptSso(v: Record<string, Record<string, unknown>>) {
    const out: Record<string, Record<string, unknown>> = {};
    for (const p of SSO_PROVIDERS) {
      out[p] = { ...(v[p] ?? {}) };
      for (const k of SSO_SECRETS) if (typeof out[p]![k] === "string") out[p]![k] = decrypt(this.config.BETTER_AUTH_SECRET, out[p]![k] as string);
    }
    return out;
  }
}

export async function getSettingRow(db: Db, key: string) {
  const [r] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return r;
}
