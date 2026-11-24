import { appendFile } from "node:fs/promises";
import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import type { MailSettings } from "../settings.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class ResendMailer implements Mailer {
  private resend: Resend;
  constructor(
    apiKey: string,
    private from: string,
  ) {
    this.resend = new Resend(apiKey);
  }
  async send(mail: Mail) {
    const { error } = await this.resend.emails.send({ from: this.from, ...mail });
    if (error) throw new Error(`Resend: ${error.message}`);
  }
}

/** Dev fallback when no RESEND_API_KEY is set: prints mail to the log. */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail) {
    console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
  }
}

/** Test mailer: keeps sent mail in memory. */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
  last(to?: string) {
    const list = to ? this.sent.filter((m) => m.to === to) : this.sent;
    return list.at(-1);
  }
}

/** E2E/dev: appends each mail as a JSON line so tests can read login codes. */
export class FileMailer implements Mailer {
  constructor(private file: string) {}
  async send(mail: Mail) {
    await appendFile(this.file, `${JSON.stringify(mail)}\n`);
  }
}

export class MailgunMailer implements Mailer {
  constructor(
    private apiKey: string,
    private domain: string,
    private region: "us" | "eu",
    private from: string,
  ) {}
  async send(mail: Mail) {
    const host = this.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    const body = new URLSearchParams({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
    if (mail.html) body.set("html", mail.html);
    const res = await fetch(`${host}/v3/${encodeURIComponent(this.domain)}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}` },
      body,
    });
    if (!res.ok) throw new Error(`Mailgun: ${res.status} ${await res.text()}`);
  }
}

export class SmtpMailer implements Mailer {
  private transport: Transporter;
  constructor(
    opts: { host: string; port: number; secure: boolean; user?: string; password?: string },
    private from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: opts.user ? { user: opts.user, pass: opts.password } : undefined,
    });
  }
  async send(mail: Mail) {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Builds the mailer for the admin's current settings. Missing credentials fall back to the log. */
export function mailerFor(s: MailSettings): Mailer {
  if (s.provider === "resend" && s.resendApiKey) return new ResendMailer(s.resendApiKey, s.from);
  if (s.provider === "mailgun" && s.mailgunApiKey && s.mailgunDomain) return new MailgunMailer(s.mailgunApiKey, s.mailgunDomain, s.mailgunRegion, s.from);
  if (s.provider === "smtp" && s.smtpHost)
    return new SmtpMailer({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpSecure, user: s.smtpUser, password: s.smtpPassword }, s.from);
  return new ConsoleMailer();
}

/** Reads the current settings on every send, so admin changes apply immediately. */
export class SettingsMailer implements Mailer {
  private cached?: { settings: MailSettings; mailer: Mailer };
  constructor(private settings: () => MailSettings) {}
  async send(mail: Mail) {
    const s = this.settings();
    if (this.cached?.settings !== s) this.cached = { settings: s, mailer: mailerFor(s) };
    await this.cached.mailer.send(mail);
  }
}
