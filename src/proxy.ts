import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Edge proxy — runs on every request before route handlers.
 *
 * (Renamed from `middleware.ts` to `proxy.ts` because Next.js 16 deprecated
 * the middleware file convention in favor of `proxy.ts`. Same behavior,
 * new name. The exported function is still `middleware` for back-compat.)
 *
 * Responsibilities:
 *   1. Generate a per-request ID (x-request-id) for log correlation.
 *      If the inbound request already has one (from an upstream proxy),
 *      preserve it; otherwise mint a fresh one.
 *   2. Set security headers on every response:
 *      - X-Content-Type-Options: nosniff
 *      - X-Frame-Options: DENY
 *      - Referrer-Policy: strict-origin-when-cross-origin
 *      - Permissions-Policy: restrictive (camera, microphone, geolocation off)
 *      - X-DNS-Prefetch-Control: off
 *   3. Strip the `x-powered-by` response header (Next.js adds it by default;
 *      also disabled via next.config.ts `poweredByHeader: false`, but we
 *      double-strip here for defense-in-depth).
 *
 * Note: CSP is intentionally NOT set here. A strict CSP requires nonce-based
 * script-src for Next.js (because Next inlines runtime scripts), and getting
 * that right requires `next.config.ts` configuration. Operators can add a
 * CSP via their reverse proxy (Caddy / nginx / Cloudflare) once they've
 * tested it against their specific deployment.
 *
 * RUNTIME: this runs in the Edge runtime (faster startup, runs at the CDN
 * edge). We can only use Web-standard APIs here — no Node.js built-ins
 * like `crypto.randomBytes`. We use `crypto.randomUUID()` from the Web
 * Crypto API instead, which is available in both Edge and Node runtimes.
 */

function generateRequestId(): string {
  // Web Crypto API — available in both Edge runtime and Node 19+.
  // `randomUUID()` returns a 36-char UUID v4 string. We slice off the
  // dashes to get a 32-char hex string for compactness in logs.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  // Fallback: Web Crypto getRandomValues (always available in Edge).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function proxy(req: NextRequest) {
  const requestId =
    req.headers.get("x-request-id") ?? generateRequestId();

  const res = NextResponse.next({
    request: {
      headers: new Headers(req.headers),
    },
  });

  // Forward the request-id to downstream route handlers (so they can include
  // it in logs).
  res.headers.set("x-request-id", requestId);

  // Security headers (applied to the response that goes back to the client).
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  );
  res.headers.set("X-DNS-Prefetch-Control", "off");
  res.headers.delete("x-powered-by");

  return res;
}

export const config = {
  /**
   * Run proxy on every route EXCEPT Next.js internals (_next/static,
   * _next/image, favicon) — those are static assets that don't need
   * per-request logging or security header munging (they get cached
   * headers from Next's static handler).
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)",
  ],
};
