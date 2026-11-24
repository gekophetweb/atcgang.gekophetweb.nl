import { PgBoss } from "pg-boss";

export type JobName = "thumbnails" | "tag-emails" | "account-deletion" | "disk-check";
type Handler = (data: Record<string, unknown>) => Promise<void>;

export interface SendOpts {
  startAfter?: Date;
  singletonKey?: string;
}

/** Background jobs. pg-boss in production (queue lives in Postgres); a manual queue in tests. */
export interface Jobs {
  register(name: JobName, handler: Handler): void;
  send(name: JobName, data: Record<string, unknown>, opts?: SendOpts): Promise<void>;
  /** Runs `name` on a cron schedule (UTC). */
  schedule(name: JobName, cron: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class PgBossJobs implements Jobs {
  private boss: PgBoss;
  private handlers = new Map<JobName, Handler>();
  private started = false;
  private schedules: [JobName, string][] = [];

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString });
    this.boss.on("error", (e) => console.error("[jobs]", e));
  }

  register(name: JobName, handler: Handler) {
    this.handlers.set(name, handler);
  }

  schedule(name: JobName, cron: string) {
    this.schedules.push([name, cron]);
  }

  async send(name: JobName, data: Record<string, unknown>, opts: SendOpts = {}) {
    await this.boss.send(name, data, {
      retryLimit: 3,
      retryBackoff: true,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
    });
  }

  async start() {
    await this.boss.start();
    this.started = true;
    for (const [name, handler] of this.handlers) {
      await this.boss.createQueue(name);
      await this.boss.work<Record<string, unknown>>(name, async (jobs) => {
        for (const job of jobs) await handler(job.data);
      });
    }
    for (const [name, cron] of this.schedules) await this.boss.schedule(name, cron, {});
  }

  async stop() {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}

/** Test queue: jobs wait until `drain()` runs the ones that are due. */
export class ManualJobs implements Jobs {
  private handlers = new Map<JobName, Handler>();
  queue: { name: JobName; data: Record<string, unknown>; runAt: number; key?: string }[] = [];

  register(name: JobName, handler: Handler) {
    this.handlers.set(name, handler);
  }
  async send(name: JobName, data: Record<string, unknown>, opts: SendOpts = {}) {
    if (opts.singletonKey && this.queue.some((j) => j.name === name && j.key === opts.singletonKey)) return;
    this.queue.push({ name, data, runAt: opts.startAfter?.getTime() ?? 0, key: opts.singletonKey });
  }
  schedule() {}
  async start() {}
  async stop() {}

  /** Runs due jobs (including jobs they enqueue) until none are left. */
  async drain(now = Date.now()) {
    for (;;) {
      const i = this.queue.findIndex((j) => j.runAt <= now);
      if (i < 0) return;
      const [job] = this.queue.splice(i, 1);
      await this.handlers.get(job!.name)!(job!.data);
    }
  }
}
