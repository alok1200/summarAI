import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookie,
  getSessionUser,
} from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Returns the currently logged-in user (or null). Used by the frontend on
 * initial page load to decide whether to show the login screen or the chat
 * UI.
 *
 * This endpoint is intentionally lenient — it returns 200 with `{user: null}`
 * when there's no session, rather than 401. This matches the frontend's
 * expectation (it just checks `user` in the response body).
 */
export async function GET() {
  const requestId = "no-req-id"; // GET has no body, but middleware still tags it
  try {
    const token = await getSessionTokenFromCookie();
    const user = await getSessionUser(token);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 200 });
    }
    // Don't log every /me call — it's polled on every page load and would
    // flood the logs. Only log errors.
    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    logger.error("auth.me.error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ user: null }, { status: 200 });
  }
}
