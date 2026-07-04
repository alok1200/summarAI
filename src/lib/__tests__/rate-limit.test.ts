import { describe, it, expect, beforeEach, mock } from "bun:test";
import { rateLimit, aiRateLimitConfig } from "@/lib/rate-limit";

describe("rateLimit", () => {
  it("allows requests up to the limit", () => {
    const cfg = { limit: 3, windowMs: 60_000, identifier: "user-A", route: "test" };
    expect(rateLimit(cfg).ok).toBe(true);
    expect(rateLimit(cfg).ok).toBe(true);
    expect(rateLimit(cfg).ok).toBe(true);
  });

  it("rejects the (limit+1)th request with 429", () => {
    const cfg = { limit: 2, windowMs: 60_000, identifier: "user-B", route: "test" };
    rateLimit(cfg);
    rateLimit(cfg);
    const third = rateLimit(cfg);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.response.status).toBe(429);
    }
  });

  it("includes standard rate-limit headers on 429", () => {
    const cfg = { limit: 1, windowMs: 60_000, identifier: "user-C", route: "test" };
    rateLimit(cfg); // consume the one allowed request
    const blocked = rateLimit(cfg);
    if (!blocked.ok) {
      const headers = blocked.response.headers;
      expect(headers.get("X-RateLimit-Limit")).toBe("1");
      expect(headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(headers.get("Retry-After")).toBeTruthy();
      expect(headers.get("X-RateLimit-Reset")).toBeTruthy();
    }
  });

  it("isolates identifiers — user A hitting the limit does not block user B", () => {
    // Use unique IDs per test so earlier tests don't exhaust the budget.
    const cfgA = { limit: 1, windowMs: 60_000, identifier: "iso-A", route: "iso-test" };
    const cfgB = { limit: 1, windowMs: 60_000, identifier: "iso-B", route: "iso-test" };
    expect(rateLimit(cfgA).ok).toBe(true);
    expect(rateLimit(cfgA).ok).toBe(false); // A exhausted
    expect(rateLimit(cfgB).ok).toBe(true);  // B still has budget
  });

  it("isolates routes — same user, different routes, separate budgets", () => {
    const cfgChat = { limit: 1, windowMs: 60_000, identifier: "iso-X", route: "iso-chat" };
    const cfgSum = { limit: 1, windowMs: 60_000, identifier: "iso-X", route: "iso-summary" };
    expect(rateLimit(cfgChat).ok).toBe(true);
    expect(rateLimit(cfgSum).ok).toBe(true); // separate budget
    expect(rateLimit(cfgChat).ok).toBe(false); // chat exhausted
  });

  it("resets the counter when the window rolls over", () => {
    // Use a 1ms window so we can wait it out cheaply.
    const cfg = { limit: 1, windowMs: 1, identifier: "user-D", route: "fast" };
    expect(rateLimit(cfg).ok).toBe(true);
    expect(rateLimit(cfg).ok).toBe(false);
    // Wait 5ms for the window to roll over (1ms window + jitter).
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }
    expect(rateLimit(cfg).ok).toBe(true); // fresh window
  });

  it("counts `remaining` correctly", () => {
    const cfg = { limit: 3, windowMs: 60_000, identifier: "user-E", route: "test" };
    const r1 = rateLimit(cfg);
    if (r1.ok) expect(r1.remaining).toBe(2);
    const r2 = rateLimit(cfg);
    if (r2.ok) expect(r2.remaining).toBe(1);
    const r3 = rateLimit(cfg);
    if (r3.ok) expect(r3.remaining).toBe(0);
  });
});

describe("aiRateLimitConfig", () => {
  beforeEach(() => {
    delete process.env.RATE_LIMIT_AI_PER_MIN;
  });

  it("defaults to 10 requests per minute", () => {
    const cfg = aiRateLimitConfig("user-1", "chat");
    expect(cfg.limit).toBe(10);
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.identifier).toBe("user-1");
    expect(cfg.route).toBe("chat");
  });

  it("respects RATE_LIMIT_AI_PER_MIN env var", () => {
    process.env.RATE_LIMIT_AI_PER_MIN = "5";
    const cfg = aiRateLimitConfig("user-2", "summary");
    expect(cfg.limit).toBe(5);
  });

  it("falls back to default if env var is invalid", () => {
    process.env.RATE_LIMIT_AI_PER_MIN = "not-a-number";
    const cfg = aiRateLimitConfig("user-3", "interview");
    expect(cfg.limit).toBe(10);
  });

  it("falls back to default if env var is zero", () => {
    process.env.RATE_LIMIT_AI_PER_MIN = "0";
    const cfg = aiRateLimitConfig("user-4", "load");
    expect(cfg.limit).toBe(10);
  });
});
