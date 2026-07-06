import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSession, setSessionCookie } from "@/lib/auth";
import { readJsonBody, sanitizeError } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EmailDirectBody {
  email?: string;
  name?: string;
}

/**
 * POST /api/auth/email-direct
 *
 * "Continue with Email" — passwordless one-click login/signup.
 *
 * User enters only their email (and an optional name on signup). We look
 * up the user by email:
 *   - If they exist → log them in (issue a session).
 *   - If they don't → create a new account with `provider = "email-direct"`,
 *     no password, and log them in.
 *
 * SECURITY POSTURE:
 *   This flow does NOT verify the user owns the email. Anyone who types
 *   `alice@example.com` is logged in as Alice. This is acceptable for:
 *     - Local development / personal prototypes
 *     - Internal tools behind a VPN
 *     - Demo environments
 *   It is NOT safe for public production deployments. For production,
 *   require passwords or implement magic-link email verification.
 *
 *   To disable this endpoint entirely, leave ENABLE_EMAIL_DIRECT unset
 *   (or set to "false"). When disabled, this route returns 404, so the
 *   frontend button also disappears.
 *
 * RATE LIMITING: 10 requests per minute per IP.
 * BODY SIZE: capped at 4 KB.
 */
export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? "no-req-id";

  // ---- Gate: only enable when explicitly opted in via env. ----
  const enabled =
    process.env.ENABLE_EMAIL_DIRECT ??
    (process.env.NODE_ENV === "production" ? "false" : "true");
  if (enabled !== "true" && enabled !== "1") {
    logger.warn("email_direct.disabled", { requestId });
    return NextResponse.json(
      { error: "Passwordless email login is not enabled on this server." },
      { status: 404 }
    );
  }

  // ---- Rate limit by IP (anonymous endpoint). ----
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rl = rateLimit({
    limit: 10,
    windowMs: 60_000,
    identifier: ip,
    route: "auth.email-direct",
  });
  if (!rl.ok) return rl.response;

  // ---- Read + validate body. ----
  const bodyResult = await readJsonBody<EmailDirectBody>(req, 4 * 1024);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.value;

  try {
    const email = (body.email ?? "").trim().toLowerCase();
    const name = (body.name ?? "").trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }
    if (email.length > 254) {
      return NextResponse.json(
        { error: "Email is too long (max 254 characters)." },
        { status: 400 }
      );
    }
    if (name.length > 100) {
      return NextResponse.json(
        { error: "Name is too long (max 100 characters)." },
        { status: 400 }
      );
    }

    // ---- Look up existing user; create if missing. ----
    let user = await db.user.findUnique({ where: { email } });
    let createdNew = false;

    if (!user) {
      const derivedName =
        name ||
        email
          .split("@")[0]
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\b\w/g, (c) => c.toUpperCase()) ||
        "New User";

      user = await db.user.create({
        data: {
          email,
          name: derivedName,
          passwordHash: null,
          provider: "email-direct",
          providerAccountId: email,
        },
      });
      createdNew = true;
      logger.info("email_direct.user_created", {
        requestId,
        userId: user.id,
        email,
      });
    } else {
      logger.info("email_direct.user_returning", {
        requestId,
        userId: user.id,
        email,
      });
    }

    // ---- Issue session. ----
    const token = await createSession(user.id);
    await setSessionCookie(token);

    logger.info("email_direct.success", {
      requestId,
      userId: user.id,
      email,
      createdNew,
    });

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
      createdNew,
    });
  } catch (err: unknown) {
    const sanitized = sanitizeError(err);
    logger.error("email_direct.error", {
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
