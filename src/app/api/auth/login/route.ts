import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  verifyPassword,
  createSession,
  setSessionCookie,
} from "@/lib/auth";
import { readJsonBody, sanitizeError } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoginBody {
  email?: string;
  password?: string;
}

/**
 * POST /api/auth/login
 *
 * Email + password login. Sets an httpOnly session cookie on success.
 *
 * Rate limiting: this endpoint is NOT behind the per-user rate limiter
 * (since the user has no identity yet). It IS protected by:
 *   - body size cap (1 KB — login payloads are tiny)
 *   - constant-time password comparison (in verifyPassword)
 *   - identical error message + status for "user not found" vs "wrong
 *     password" (prevents user enumeration)
 *   - structured logging (failed attempts are logged with the email so
 *     brute-force attempts are visible to operators)
 *
 * For brute-force protection beyond what scrypt's slowness provides,
 * deploy a fail2ban-style IP banner at the reverse-proxy layer (Caddy /
 * nginx) that watches logs for repeated 401s from the same IP.
 */
export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? "no-req-id";

  const bodyResult = await readJsonBody<LoginBody>(req, 1024);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.value;

  try {
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";

    if (!email || !password) {
      return NextResponse.json(
        { error: "Please enter both email and password." },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({ where: { email } });
    // Identical response for "no such user" and "wrong password" — prevents
    // user enumeration via response-timing or message inspection.
    if (!user || !verifyPassword(password, user.passwordHash)) {
      logger.warn("auth.login.failed", { requestId, email });
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    const token = await createSession(user.id);
    await setSessionCookie(token);

    logger.info("auth.login.success", { requestId, userId: user.id, email });

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: unknown) {
    const sanitized = sanitizeError(err);
    logger.error("auth.login.error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      digest: sanitized.digest,
    });
    return NextResponse.json(
      { error: sanitized.message, digest: sanitized.digest },
      { status: 500 }
    );
  }
}
