import { Resend } from "resend";

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
