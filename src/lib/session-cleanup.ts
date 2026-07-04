import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Delete expired sessions from the DB.
 *
 * WHY: expired sessions are normally deleted lazily when a request tries to
 * use them (see getSessionUser in auth.ts). But if a user just stops using
 * the app, their expired sessions sit in the DB forever, growing the table.
 * For a chat app with 30-day session TTL, that's a slow leak — but it's
 * still a leak. This function purges them.
 *
 * WHEN: called from /api/health on a probabilistic schedule (~1% of requests
 * = once every ~100 health checks ≈ once every few minutes on a busy box).
 * This avoids needing a separate cron job for something so cheap.
 *
 * Returns the number of rows deleted.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  try {
    const result = await db.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      logger.info("session.cleanup", { deleted: result.count });
    }
    return result.count;
  } catch (err) {
    logger.error("session.cleanup.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Probabilistic cleanup — call this from a frequently-hit endpoint to
 * run cleanup ~1% of the time. Returns immediately the other 99%.
 *
 * The Math.random check is intentionally cheap so the 99% path costs
 * essentially nothing (one function call, one comparison, one return).
 */
export function maybeCleanupExpiredSessions(probability: number = 0.01): void {
  if (Math.random() >= probability) return;
  // Fire-and-forget — don't block the request on cleanup.
  void cleanupExpiredSessions();
}
