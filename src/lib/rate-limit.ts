import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * In-memory sliding-window rate limiter for AI/LLM endpoints.
 *
 * WHY IN-MEMORY (not Redis)?
 *   This app is designed to run as a single Node/Bun process behind Caddy.
 *   For multi-instance deployments, swap the `store` Map for a Redis backend.
 *
 * ALGORITHM: fixed-window per (userId, route-key). Each window of `windowMs`
 * milliseconds has its own counter. When the window rolls over, the counter
 * resets. This is the simplest correct rate-limiting algorithm — token-bucket
 * would be smoother but adds complexity without meaningful benefit for
 * per-user LLM quotas.
 *
 * LIMITS (defaults, tunable via env):
 *   - 10 requests per minute per user on chat/summary/interview/load
 *   - 60 requests per minute per user on free /api/health and other GETs
 *
 * LIMITS ARE PER-USER (after auth). Anonymous requests are rate-limited by
 * IP address from the `x-forwarded-for` header (set by Caddy in production).
 */

interface RateBucket {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  /** Max requests per window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Stable identifier for the rate-limit key (usually user id or IP). */
  identifier: string;
  /** Human-readable label for the route (used in error messages). */
  route: string;
}

const store = new Map<string, RateBucket>();

// Periodically sweep expired buckets so the Map doesn't grow unboundedly.
// Set an interval only once per process (module-level singleton).
let sweepStarted = false;
function startSweeper() {
  if (sweepStarted) return;
  sweepStarted = true;
  // Use setInterval via setTimeout-style to avoid blocking startup.
  const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
  const sweep = () => {
    const now = Date.now();
    for (const [key, bucket] of store) {
      // Buckets are created with a 60s window by default; if a bucket hasn't
      // been touched in 10 minutes, it's safe to evict.
      if (now - bucket.windowStart > 10 * 60 * 1000) {
        store.delete(key);
      }
    }
    setTimeout(sweep, SWEEP_INTERVAL_MS);
  };
  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/**
 * Check the rate limit for the given config. Returns `{ ok: true }` if the
 * request is allowed, or `{ ok: false, response }` if it should be rejected
 * with 429 Too Many Requests.
 *
 * The response includes the standard rate-limit headers:
 *   - X-RateLimit-Limit     — max requests per window
 *   - X-RateLimit-Remaining — remaining requests in this window
 *   - X-RateLimit-Reset     — unix seconds when the window resets
 *   - Retry-After           — seconds until the caller may retry
 */
export function rateLimit(
  config: RateLimitConfig
):
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; response: NextResponse } {
  startSweeper();

  const key = `${config.route}:${config.identifier}`;
  const now = Date.now();
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const resetAt = windowStart + config.windowMs;
  const retryAfterSec = Math.ceil((resetAt - now) / 1000);

  const existing = store.get(key);
  let bucket: RateBucket;
  if (!existing || existing.windowStart < windowStart) {
    // New window.
    bucket = { count: 0, windowStart };
  } else {
    bucket = existing;
  }

  bucket.count += 1;
  store.set(key, bucket);

  const remaining = Math.max(0, config.limit - bucket.count);

  if (bucket.count > config.limit) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Rate limit exceeded for ${config.route}. Try again in ${retryAfterSec}s.`,
          retryAfter: retryAfterSec,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(config.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.floor(resetAt / 1000)),
            "Retry-After": String(retryAfterSec),
            "Cache-Control": "no-store",
          },
        }
      ),
    };
  }

  return { ok: true, remaining, resetAt };
}

/**
 * Convenience: default rate limit for AI/LLM endpoints (per-user, 10/min).
 * Tunable via RATE_LIMIT_AI_PER_MIN env var (default: 10).
 */
export function aiRateLimitConfig(identifier: string, route: string): RateLimitConfig {
  const limit = Number(process.env.RATE_LIMIT_AI_PER_MIN ?? "10") || 10;
  return {
    limit,
    windowMs: 60_000,
    identifier,
    route,
  };
}
