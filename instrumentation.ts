/**
 * Next.js instrumentation hook — runs ONCE when the server boots, before
 * any request is served. Official Next.js feature:
 *   https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * We use it for startup-time environment validation: if GEMINI_API_KEY or
 * DATABASE_URL is missing/invalid, the server refuses to start (production)
 * or throws immediately (development). This surfaces misconfiguration at
 * boot time instead of letting the app silently 500 on every request.
 *
 * This file must be at the project root (next to next.config.ts) or at
 * src/instrumentation.ts if you set `instrumentationHook: true` in
 * next.config.ts. Next.js 16 auto-detects it at the root by default.
 */
export async function register(): Promise<void> {
  const { assertEnvOrExit } = await import("./src/lib/env");
  assertEnvOrExit();
}
