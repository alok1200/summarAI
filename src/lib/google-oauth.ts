import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

/**
 * Google OAuth 2.0 helpers — Authorization Code flow with state parameter
 * for CSRF protection.
 *
 * FLOW (end-to-end):
 *
 *   1. User clicks "Sign in with Google" →
 *      GET /api/auth/google
 *      → server generates a state token, stores it in a short-lived
 *        httpOnly cookie (`google_oauth_state`), redirects to:
 *        https://accounts.google.com/o/oauth2/v2/auth?...&state=...
 *
 *   2. User consents on Google → Google redirects to:
 *      GET /api/auth/google/callback?code=...&state=...
 *      → server reads the state cookie, verifies it matches the `state`
 *        query param (CSRF check), exchanges `code` for tokens at
 *        Google's token endpoint, fetches user info from Google's
 *        userinfo endpoint, creates/looks up the user in our DB, creates
 *        a session, sets the session cookie, clears the state cookie,
 *        redirects to /.
 *
 * WHY THIS APPROACH (vs. NextAuth):
 *   The project has `next-auth` installed but not wired up. Hand-rolling
 *   Google OAuth is simpler — one less abstraction layer, full control
 *   over the user-creation/lookup logic, and we reuse the existing
 *   session infrastructure (same Session table, same session cookie).
 *
 * ENV VARS (all required for Google login to work):
 *   GOOGLE_CLIENT_ID     — from Google Cloud Console → APIs & Services → Credentials
 *   GOOGLE_CLIENT_SECRET — same place
 *   GOOGLE_REDIRECT_URI  — full public URL of /api/auth/google/callback
 *                          (e.g. https://example.com/api/auth/google/callback)
 *   SESSION_SECRET       — already used for session tokens; we also use it
 *                          to HMAC-sign the state parameter.
 *
 * GRACEFUL DEGRADATION:
 *   If any of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
 *   is unset, `isGoogleOAuthConfigured()` returns false and the API returns
 *   a 503 with setup instructions. The frontend button is hidden in this
 *   case (see LoginScreen).
 */

const STATE_COOKIE = "google_oauth_state";
const STATE_TTL_SEC = 10 * 60; // 10 minutes
const STATE_TTL_MS = STATE_TTL_SEC * 1000;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Scopes — openid + email + profile is the minimum needed to identify the
// user. We don't request any other Google API access.
const SCOPES = ["openid", "email", "profile"];

export interface GoogleUserInfo {
  sub: string;            // stable Google user ID
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

/**
 * Returns true iff all three required env vars are set.
 * Use this to decide whether to show the "Sign in with Google" button.
 */
export function isGoogleOAuthConfigured(): boolean {
  return (
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET &&
    !!process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Resolve the session-signing secret. Reuses SESSION_SECRET (the same one
 * used for session tokens) to HMAC-sign the OAuth state parameter.
 * Returns null if SESSION_SECRET is unset (in which case we fall back to
 * a random per-process secret — still works, just doesn't survive restarts).
 */
function getStateSecret(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (raw && raw.trim() !== "") return Buffer.from(raw, "utf8");
  // Fallback: random per-process secret. State will be invalid after a
  // server restart, but that's fine — the user just clicks the button
  // again. (This matches the session-token fallback behavior.)
  return Buffer.from(
    Math.random().toString(36).slice(2) + Date.now().toString(36),
    "utf8"
  );
}

/**
 * Generate a state token: `<random>.<hmac>`. The random part is sent to
 * Google and back; the HMAC prevents an attacker from forging a state
 * token (which would let them mount a login CSRF attack).
 *
 * The token is stored in a cookie on the user's browser; on callback, we
 * compare the cookie value to the `state` query param. This is the
 * standard OAuth 2.0 state-parameter CSRF defense.
 */
export function makeStateToken(): string {
  const random = Math.random().toString(36).slice(2) +
                 Date.now().toString(36);
  const secret = getStateSecret();
  const sig = createHmac("sha256", secret).update(random).digest("hex");
  return `${random}.${sig}`;
}

/**
 * Verify a state token's HMAC signature. Returns true iff the signature
 * matches (constant-time comparison) — does NOT check expiry (that's the
 * cookie's job).
 */
function verifyStateToken(token: string): boolean {
  const [random, sig] = token.split(".");
  if (!random || !sig) return false;
  const secret = getStateSecret();
  const expectedSig = createHmac("sha256", secret).update(random).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Set the state cookie. Called from the GET /api/auth/google handler
 * before redirecting to Google.
 */
export async function setStateCookie(state: string): Promise<void> {
  const store = await cookies();
  store.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",     // must be 'lax' so the browser sends it on the
                         // top-level redirect back from Google
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SEC,
  });
}

/**
 * Read + verify the state cookie. Called from the callback handler.
 * Returns true iff the cookie exists, its HMAC is valid, AND it matches
 * the `state` query param. Always clears the cookie afterward (one-shot).
 */
export async function verifyAndConsumeStateCookie(stateParam: string): Promise<boolean> {
  const store = await cookies();
  const cookieValue = store.get(STATE_COOKIE)?.value;
  // Always clear the cookie — one-shot, even on failure.
  store.set(STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  if (!cookieValue) return false;
  if (!verifyStateToken(cookieValue)) return false;
  // Constant-time comparison of the cookie value vs. the query param.
  // Both should be `<random>.<hmac>` and identical.
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(stateParam);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build the Google OAuth consent URL. The user is redirected here to
 * approve our app's access to their basic profile.
 */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    // 'select_account' prompts the user to pick which Google account to
    // use (rather than auto-selecting the one they're logged in as).
    // This matters for users with multiple Google accounts.
    prompt: "select_account",
    // 'consent' would force the consent screen every time; we use
    // 'select_account' instead so returning users get a smoother flow.
    access_type: "online", // we don't need refresh tokens
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for an ID token + access token.
 * Throws on any error.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  idToken?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Google token exchange failed: ${res.status} ${errText.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    id_token?: string;
    error?: string;
  };
  if (data.error || !data.access_token) {
    throw new Error(
      `Google token exchange error: ${data.error || "no access_token"}`
    );
  }
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
  };
}

/**
 * Fetch the user's profile from Google's userinfo endpoint using the
 * access token. Returns the user's stable ID (`sub`), verified email,
 * name, and profile picture URL.
 *
 * Throws on any error.
 */
export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Google userinfo fetch failed: ${res.status}`
    );
  }
  const data = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    picture?: string;
  };
  if (!data.sub || !data.email) {
    throw new Error(
      "Google userinfo response missing sub or email"
    );
  }
  return {
    sub: data.sub,
    email: data.email.toLowerCase(),
    emailVerified:
      data.email_verified === true || data.email_verified === "true",
    name: data.name || data.email.split("@")[0],
    picture: data.picture,
  };
}

/**
 * Build a relative redirect URL that carries an error message back to the
 * frontend (which displays it on the login screen). We use a query param
 * rather than a cookie because the error is one-shot and the frontend
 * doesn't need to persist it.
 */
export function buildErrorRedirect(message: string): string {
  return `/?auth_error=${encodeURIComponent(message)}`;
}
