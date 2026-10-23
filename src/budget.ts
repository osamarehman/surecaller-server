/**
 * In-memory fixed-window budget where one request can cost more than 1
 * (e.g. a batch lookup costs one unit per number). Single-process only, like
 * the @fastify/rate-limit default store.
 */
export class Budget {
  private windows = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Charges `cost` units to `key`. Returns 0 when allowed, otherwise the
   * milliseconds until the window resets (nothing is charged).
   */
  take(key: string, cost: number, now = Date.now()): number {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(now);
      w = { start: now, used: 0 };
      this.windows.set(key, w);
    }
    if (w.used + cost > this.max) return Math.max(1, w.start + this.windowMs - now);
    w.used += cost;
    return 0;
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
