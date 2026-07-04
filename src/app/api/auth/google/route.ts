import { NextResponse } from "next/server";
import {
  isGoogleOAuthConfigured,
  buildAuthUrl,
  makeStateToken,
  setStateCookie,
} from "@/lib/google-oauth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google
 *
 * Entry point for "Sign in with Google". Generates a state token, stores
 * it in a short-lived httpOnly cookie, and redirects the user to Google's
 * OAuth consent screen.
 *
 * After the user consents, Google redirects them to
 * /api/auth/google/callback?code=...&state=... — see that route for the
 * second half of the flow.
 *
 * If Google OAuth isn't configured (missing env vars), returns 503 with
 * setup instructions so operators see immediately what's wrong.
 */
export async function GET() {
  if (!isGoogleOAuthConfigured()) {
    logger.warn("google_oauth.not_configured");
    return NextResponse.json(
      {
        error:
          "Google Sign-In is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in your .env file. See .env.example for details.",
      },
      { status: 503 }
    );
  }

  const state = makeStateToken();
  await setStateCookie(state);
  const authUrl = buildAuthUrl(state);

  logger.info("google_oauth.start", { statePrefix: state.slice(0, 8) });

  // 302 redirect — the browser follows it automatically.
  return NextResponse.redirect(authUrl, { status: 302 });
}
