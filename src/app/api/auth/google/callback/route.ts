import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  isGoogleOAuthConfigured,
  verifyAndConsumeStateCookie,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  buildErrorRedirect,
} from "@/lib/google-oauth";
import { createSession, setSessionCookie } from "@/lib/auth";
import { sanitizeError } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/callback?code=...&state=...
 *
 * Second half of the Google OAuth flow. Google redirects here after the
 * user consents. We:
 *   1. Verify the `state` query param matches the state cookie
 *      (CSRF defense).
 *   2. Exchange the `code` for tokens at Google's token endpoint.
 *   3. Fetch the user's profile from Google's userinfo endpoint.
 *   4. Look up the user in our DB by (provider=google, providerAccountId=sub).
 *      - If not found, look up by email — if a user with that email exists
 *        (created via email/password), link the Google account to them
 *        by setting provider fields. This is safe because Google's email
 *        is verified.
 *      - If still not found, create a new user with provider=google and
 *        no password (they're an OAuth-only user).
 *   5. Create a session, set the session cookie.
 *   6. Redirect to / (the chat UI).
 *
 * On any error, redirect to / with ?auth_error=... so the login screen
 * can display the message.
 */
export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? "no-req-id";

  // 0. Pre-flight: env vars still configured? (Could have been unset
  //    between the start and callback — unlikely but cheap to check.)
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.redirect(
      buildErrorRedirect("Google Sign-In is not configured on the server."),
      { status: 302 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const code = sp.get("code");
  const stateParam = sp.get("state");
  const googleError = sp.get("error");

  // Google can return `error=access_denied` if the user clicked "Cancel".
  if (googleError) {
    logger.warn("google_oauth.denied", {
      requestId,
      error: googleError,
    });
    return NextResponse.redirect(
      buildErrorRedirect(
        googleError === "access_denied"
          ? "You cancelled the Google sign-in. You can try again or sign in with email and password."
          : `Google sign-in failed: ${googleError}`
      ),
      { status: 302 }
    );
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(
      buildErrorRedirect("Google sign-in callback is missing required parameters."),
      { status: 302 }
    );
  }

  // 1. Verify state — CSRF defense.
  const stateOk = await verifyAndConsumeStateCookie(stateParam);
  if (!stateOk) {
    logger.warn("google_oauth.state_mismatch", { requestId });
    return NextResponse.redirect(
      buildErrorRedirect(
        "Google sign-in state verification failed. This can happen if you took too long, or if your browser blocked cookies. Please try again."
      ),
      { status: 302 }
    );
  }

  // 2. Exchange code for tokens.
  let tokens: { accessToken: string; idToken?: string };
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    logger.error("google_oauth.token_exchange_failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(
      buildErrorRedirect(
        "Could not complete Google sign-in (token exchange failed). Please try again."
      ),
      { status: 302 }
    );
  }

  // 3. Fetch user info from Google.
  let googleUser;
  try {
    googleUser = await fetchGoogleUserInfo(tokens.accessToken);
  } catch (err) {
    logger.error("google_oauth.userinfo_failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(
      buildErrorRedirect(
        "Could not fetch your Google profile. Please try again."
      ),
      { status: 302 }
    );
  }

  if (!googleUser.emailVerified) {
    logger.warn("google_oauth.email_not_verified", {
      requestId,
      email: googleUser.email,
    });
    return NextResponse.redirect(
      buildErrorRedirect(
        "Your Google account's email is not verified. Please verify it in your Google account settings and try again."
      ),
      { status: 302 }
    );
  }

  // 4. Find or create the user.
  let user;
  try {
    // (a) Look up by Google's stable sub ID.
    user = await db.user.findFirst({
      where: {
        provider: "google",
        providerAccountId: googleUser.sub,
      },
    });

    if (!user) {
      // (b) Look up by email — if a user with that email already exists
      // (e.g. they signed up with email/password earlier), link the
      // Google account to that user. This is safe because Google has
      // verified the email.
      user = await db.user.findUnique({
        where: { email: googleUser.email },
      });

      if (user) {
        // Link the Google account to the existing user.
        user = await db.user.update({
          where: { id: user.id },
          data: {
            provider: "google",
            providerAccountId: googleUser.sub,
            // Don't clear passwordHash — the user can still log in with
            // either method. (If they want to "disconnect" Google later,
            // that's a separate feature.)
            // Update name if Google's is set and ours is empty.
            name: user.name || googleUser.name,
          },
        });
        logger.info("google_oauth.linked_existing_user", {
          requestId,
          userId: user.id,
          email: googleUser.email,
        });
      } else {
        // (c) No existing user — create a new one.
        user = await db.user.create({
          data: {
            email: googleUser.email,
            name: googleUser.name,
            // passwordHash is null — this is an OAuth-only user.
            provider: "google",
            providerAccountId: googleUser.sub,
          },
        });
        logger.info("google_oauth.created_user", {
          requestId,
          userId: user.id,
          email: googleUser.email,
        });
      }
    }
  } catch (err) {
    const sanitized = sanitizeError(err);
    logger.error("google_oauth.db_error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      digest: sanitized.digest,
    });
    return NextResponse.redirect(
      buildErrorRedirect(
        "Could not create or update your account. Please try again."
      ),
      { status: 302 }
    );
  }

  // 5. Create session, set cookie.
  const token = await createSession(user.id);
  await setSessionCookie(token);

  logger.info("google_oauth.success", {
    requestId,
    userId: user.id,
    email: user.email,
  });

  // 6. Redirect to the chat UI.
  return NextResponse.redirect(new URL("/", req.url), { status: 302 });
}
