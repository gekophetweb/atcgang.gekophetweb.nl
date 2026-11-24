import type { Config } from "./config.js";
import { createDb } from "./db/client.js";
import { appleClientSecret, createAuth, enabledProviders } from "./auth.js";
import { ConsoleMailer, ResendMailer, type Mailer } from "./lib/mailer.js";
import { createApp } from "./app.js";
import { VolumeStorage, type Storage } from "./lib/storage.js";
import { PgBossJobs, type Jobs } from "./lib/jobs.js";
import { makeThumbnails } from "./domain/photos.js";
import { createNotifier } from "./domain/notifications.js";

export interface ServiceOverrides {
  mailer?: Mailer;
  storage?: Storage;
  jobs?: Jobs;
  otpLimits?: { perEmail: number; perIp: number };
}

/** Wires config → db, mailer, auth and the Hono app. Used by the server entrypoint and by tests. */
export async function createServices(config: Config, overrides: ServiceOverrides = {}) {
  const { db, sql } = createDb(config.DATABASE_URL);
  const mailer =
    overrides.mailer ?? (config.RESEND_API_KEY ? new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM) : new ConsoleMailer());
  const appleSecret = await appleClientSecret(config);
  const auth = createAuth({ config, db, mailer, appleClientSecret: appleSecret, otpLimits: overrides.otpLimits });
  const providers = enabledProviders(config, appleSecret);
  const storage = overrides.storage ?? new VolumeStorage(config.PHOTO_DIR);
  const jobs = overrides.jobs ?? new PgBossJobs(config.DATABASE_URL);
  jobs.register("thumbnails", (d) => makeThumbnails(db, storage, String(d.photoId)));
  const notify = createNotifier({ db, jobs, mailer, baseUrl: config.BASE_URL, secret: config.BETTER_AUTH_SECRET });
  jobs.register("tag-emails", (d) => notify.sendTagEmail(String(d.batchId)));
  const app = createApp({ config, db, auth, mailer, providers, storage, jobs, notify });
  return { config, db, sql, mailer, auth, app, providers, storage, jobs, notify,
    close: async () => {
      await jobs.stop();
      await sql.end({ timeout: 5 });
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
