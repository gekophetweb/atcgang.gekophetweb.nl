import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  PHOTO_DIR: z.string().default("./data/photos"),
  CLIENT_DIR: z.string().default("./dist/client"),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().default(2 * 1024 ** 3),
  RESEND_API_KEY: optional,
  MAIL_FROM: z.string().default("ATC Gang <noreply@gekophetweb.nl>"),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  MICROSOFT_CLIENT_ID: optional,
  MICROSOFT_CLIENT_SECRET: optional,
  APPLE_CLIENT_ID: optional,
  APPLE_TEAM_ID: optional,
  APPLE_KEY_ID: optional,
  APPLE_PRIVATE_KEY: optional,
  APPLE_APP_BUNDLE_IDENTIFIER: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  TURNSTILE_SITE_KEY: optional,
  TURNSTILE_SECRET_KEY: optional,
  /** Trust CF-Connecting-IP. Only safe because nothing reaches `web` except through cloudflared. */
  TRUST_CF_HEADERS: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  DISK_ALERT_PERCENT: z.coerce.number().default(80),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
