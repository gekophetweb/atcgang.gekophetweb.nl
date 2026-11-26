/** Fixed-window in-memory limiter. One `web` instance, so memory is enough; a restart resets the counters. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Records a hit and returns whether it is allowed. */
  hit(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      this.sweep(t);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  private sweep(t: number) {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
