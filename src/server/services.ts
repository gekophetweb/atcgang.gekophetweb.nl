import type { Config } from "./config.js";
import { createDb } from "./db/client.js";
import { appleClientSecret, createAuth, enabledProviders } from "./auth.js";
import { ConsoleMailer, ResendMailer, type Mailer } from "./lib/mailer.js";
import { createApp } from "./app.js";

export interface ServiceOverrides {
  mailer?: Mailer;
}

/** Wires config → db, mailer, auth and the Hono app. Used by the server entrypoint and by tests. */
export async function createServices(config: Config, overrides: ServiceOverrides = {}) {
  const { db, sql } = createDb(config.DATABASE_URL);
  const mailer =
    overrides.mailer ?? (config.RESEND_API_KEY ? new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM) : new ConsoleMailer());
  const appleSecret = await appleClientSecret(config);
  const auth = createAuth({ config, db, mailer, appleClientSecret: appleSecret });
  const providers = enabledProviders(config, appleSecret);
  const app = createApp({ config, db, auth, mailer, providers });
  return { config, db, sql, mailer, auth, app, providers, close: () => sql.end({ timeout: 5 }) };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
