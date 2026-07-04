import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookie,
  destroySession,
  clearSessionCookie,
} from "@/lib/auth";
import { sanitizeError } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * Destroys the current session in the DB and clears the session cookie.
 * Idempotent — calling it with no session returns 200 (no-op).
 */
export async function POST() {
  try {
    const token = await getSessionTokenFromCookie();
    if (token) {
      await destroySession(token);
    }
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const sanitized = sanitizeError(err);
    logger.error("auth.logout.error", {
      error: err instanceof Error ? err.message : String(err),
      digest: sanitized.digest,
    });
    return NextResponse.json(
      { error: sanitized.message, digest: sanitized.digest },
      { status: 500 }
    );
  }
}
