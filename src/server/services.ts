import { inArray } from "drizzle-orm";
import type { Config } from "./config.js";
import { createDb } from "./db/client.js";
import { users } from "./db/schema.js";
import { appleClientSecret, createAuth, defaultLimiters, enabledProviders, type Auth } from "./auth.js";
import { FileMailer, SettingsMailer, type Mailer } from "./lib/mailer.js";
import { deleteAccount, adminOverview } from "./domain/account.js";
import { createApp } from "./app.js";
import { VolumeStorage, type Storage } from "./lib/storage.js";
import { PgBossJobs, type Jobs } from "./lib/jobs.js";
import { makeThumbnails } from "./domain/photos.js";
import { createNotifier } from "./domain/notifications.js";
import { SettingsStore, ssoReady } from "./settings.js";

export interface ServiceOverrides {
  mailer?: Mailer;
  storage?: Storage;
  jobs?: Jobs;
  otpLimits?: { perEmail: number; perIp: number };
}

/** Wires config → db, settings, mailer, auth and the Hono app. Used by the server entrypoint and by tests. */
export async function createServices(config: Config, overrides: ServiceOverrides = {}) {
  const { db, sql } = createDb(config.DATABASE_URL);
  const settings = new SettingsStore(db, config);
  await settings.load();

  const mailer =
    overrides.mailer ??
    (config.MAIL_OUTBOX_FILE && config.NODE_ENV !== "production" ? new FileMailer(config.MAIL_OUTBOX_FILE) : new SettingsMailer(() => settings.mail));

  // Better Auth's providers are fixed per instance, so the instance is rebuilt when an admin
  // changes SSO settings (and daily, to mint a fresh Apple client secret). Everything holds a
  // proxy that always points at the current instance.
  const limiters = overrides.otpLimits ? defaultLimiters(overrides.otpLimits.perEmail, overrides.otpLimits.perIp) : defaultLimiters();
  let current: Auth;
  let providers: string[] = [];
  async function rebuildAuth() {
    const sso = settings.sso;
    const appleSecret = ssoReady("apple", sso.apple) ? await appleClientSecret(sso.apple).catch(() => undefined) : undefined;
    current = createAuth({ config, db, mailer, sso, appleClientSecret: appleSecret, limiters });
    providers = enabledProviders(sso, appleSecret);
  }
  await rebuildAuth();
  settings.onChange(rebuildAuth);
  const auth = new Proxy({} as Auth, { get: (_t, k) => Reflect.get(current, k) });

  const storage = overrides.storage ?? new VolumeStorage(config.PHOTO_DIR);
  const jobs = overrides.jobs ?? new PgBossJobs(config.DATABASE_URL);
  jobs.register("thumbnails", (d) => makeThumbnails(db, storage, String(d.photoId)));
  const notify = createNotifier({ db, jobs, mailer, baseUrl: config.BASE_URL, secret: config.BETTER_AUTH_SECRET });
  jobs.register("tag-emails", (d) => notify.sendTagEmail(String(d.batchId)));
  jobs.register("account-deletion", (d) => deleteAccount(db, storage, String(d.userId)));
  jobs.register("disk-check", async () => {
    const o = await adminOverview(db, storage, config.DISK_ALERT_PERCENT);
    if (!o.disk?.alert) return;
    for (const a of o.users.filter((u) => u.role === "admin" && !u.disabled)) {
      await mailer.send({
        to: a.email,
        subject: `ATC Gang: photo disk ${o.disk.usedPercent}% full`,
        text: `The photo disk is ${o.disk.usedPercent}% full (${Math.round(o.disk.free / 1e9)} GB free). See ${config.BASE_URL}/admin.`,
      });
    }
  });
  jobs.schedule("disk-check", "0 8 * * *");
  if (config.ADMIN_EMAILS.length) {
    await db.update(users).set({ role: "admin" }).where(inArray(users.email, config.ADMIN_EMAILS));
  }

  const app = createApp({ config, db, auth, mailer, providers: () => providers, storage, jobs, notify, settings });
  return {
    config,
    db,
    sql,
    mailer,
    auth,
    app,
    providers: () => providers,
    rebuildAuth,
    settings,
    storage,
    jobs,
    notify,
    close: async () => {
      await jobs.stop();
      await sql.end({ timeout: 5 });
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
