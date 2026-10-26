import type { MiddlewareHandler } from 'hono';
import { ApiError } from './errors';

/**
 * Fixed-window in-memory limiter. Adequate for a single API instance; behind several
 * instances use the hosting platform's limiter or a shared store instead.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: (c: Parameters<MiddlewareHandler>[0]) => string }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    const key = opts.key(c);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.');
    }
    await next();
  };
}

export function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const fwd = c.req.header('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
}
