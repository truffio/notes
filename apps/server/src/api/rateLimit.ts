export interface RateLimiter {
  /** Counts one attempt. Returns seconds to wait if over the limit, otherwise null. */
  hit(key: string, nowMs: number): number | null;
}

/** Fixed-window, in-memory limiter. Expired windows are dropped as it runs. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, nowMs) {
      // Windows have one length, so insertion order is also expiry order.
      for (const [windowKey, window] of windows) {
        if (window.resetAt > nowMs) break;
        windows.delete(windowKey);
      }
      const current = windows.get(key);
      if (!current) {
        windows.set(key, { count: 1, resetAt: nowMs + windowMs });
        return null;
      }
      if (current.count >= limit) return Math.ceil((current.resetAt - nowMs) / 1000);
      current.count += 1;
      return null;
    },
  };
}
