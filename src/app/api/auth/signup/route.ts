import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  createSession,
  setSessionCookie,
} from "@/lib/auth";
import { readJsonBody, sanitizeError } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SignupBody {
  email?: string;
  password?: string;
  name?: string;
}

/**
 * POST /api/auth/signup
 *
 * Email + password registration. Sets an httpOnly session cookie on success.
 *
 * Password rules: minimum 6 characters. This is intentionally lenient —
 * the password is hashed with scrypt (memory-hard, slow to brute-force),
 * and a stricter policy would just push users to password reuse. For a
 * real production deployment, consider integrating haveibeenpwned's Pwned
 * Passwords API (k-anonymity model) to reject known-breached passwords.
 *
 * Rate limiting: same reasoning as /api/auth/login — no identity yet,
 * so per-user limiter doesn't apply. Body size capped at 4 KB.
 */
export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? "no-req-id";

  const bodyResult = await readJsonBody<SignupBody>(req, 4 * 1024);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.value;

  try {
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const name = (body.name ?? "").trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long." },
        { status: 400 }
      );
    }
    if (password.length > 1024) {
      // Hard cap to prevent abuse (scrypt is memory-hard; a 1MB password
      // would consume GBs of memory).
      return NextResponse.json(
        { error: "Password is too long (max 1024 characters)." },
        { status: 400 }
      );
    }
    if (!name) {
      return NextResponse.json(
        { error: "Please enter your name." },
        { status: 400 }
      );
    }
    if (name.length > 100) {
      return NextResponse.json(
        { error: "Name is too long (max 100 characters)." },
        { status: 400 }
      );
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists. Try logging in." },
        { status: 409 }
      );
    }

    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash: hashPassword(password),
      },
    });

    const token = await createSession(user.id);
    await setSessionCookie(token);

    logger.info("auth.signup.success", { requestId, userId: user.id, email });

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: unknown) {
    const sanitized = sanitizeError(err);
    logger.error("auth.signup.error", {
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
