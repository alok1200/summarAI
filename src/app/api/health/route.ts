import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { maybeCleanupExpiredSessions } from "@/lib/session-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Liveness + readiness probe for container orchestrators (k8s, ECS,
 * Docker Swarm) and reverse proxies (Caddy, nginx, ALB).
 *
 * Returns 200 with a JSON status object when the server is alive AND the
 * database is reachable. Returns 503 if the DB ping fails (so the load
 * balancer can stop routing traffic to this instance until it recovers).
 *
 * This endpoint is intentionally NOT authenticated — health checks must
 * succeed without a session cookie or the orchestrator will mark the
 * instance unhealthy and restart it.
 *
 * It's also rate-limit-free; the response is ~100 bytes and the only
 * work is a single DB count query.
 */
export async function GET() {
  const start = Date.now();

  // Probabilistically sweep expired sessions. Cheap (one DELETE), runs ~1%
  // of the time, keeps the sessions table from growing unboundedly.
  maybeCleanupExpiredSessions();

  // 1. Process alive — if we got here, the Node/Bun process is running.
  const uptimeSec = Math.round(process.uptime());
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // 2. DB reachable — a tiny count query. If this throws, the DB is down
  //    (or the connection pool is exhausted), and we return 503 so the
  //    load balancer can route around us.
  let dbOk = true;
  let dbError: string | undefined;
  try {
    await db.user.count();
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - start;
  const ok = dbOk;

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      uptimeSec,
      memoryMb,
      checks: {
        db: { ok: dbOk, error: dbError, durationMs },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    }
  );
}
