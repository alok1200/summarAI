import { db } from "@/lib/db";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "chatgpt_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Resolve the session-signing secret. If SESSION_SECRET is set in the
 * environment, we use it to HMAC-sign the random session token — this means
 * tokens are tied to this server's secret (an attacker who only steals the DB
 * can't forge a valid token). If SESSION_SECRET is empty (dev mode), we fall
 * back to pure random tokens, which are still cryptographically secure but
 * don't get the extra server-side binding.
 */
function getSessionSecret(): Buffer | null {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.trim() === "") return null;
  return Buffer.from(raw, "utf8");
}

// ---------- Password hashing (scrypt) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(password, salt, 64);
  if (hashBuf.length !== testBuf.length) return false;
  return timingSafeEqual(hashBuf, testBuf);
}

// ---------- Session management ----------

/**
 * Generate a session token. Format:
 *   - If SESSION_SECRET is set:  <random>.<hmac>
 *     The random part is stored in the DB; the HMAC is verified on every
 *     request so a DB-only leak can't forge tokens.
 *   - If SESSION_SECRET is empty (dev):  just the random part.
 */
export async function createSession(userId: string): Promise<string> {
  const random = randomBytes(32).toString("hex");
  const secret = getSessionSecret();
  let token: string;
  if (secret) {
    const sig = createHmac("sha256", secret).update(random).digest("hex");
    token = `${random}.${sig}`;
  } else {
    token = random;
  }
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: { token, userId, expiresAt },
  });
  return token;
}

export async function getSessionUser(token: string | undefined) {
  if (!token) return null;

  // If SESSION_SECRET is set, verify the token's HMAC signature BEFORE hitting
  // the database. This lets us reject forged tokens cheaply (no DB round-trip).
  const secret = getSessionSecret();
  if (secret) {
    const [random, sig] = token.split(".");
    if (!random || !sig) return null;
    const expectedSig = createHmac("sha256", secret).update(random).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  }

  const session = await db.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { token } }).catch(() => {});
}

// ---------- Cookie helpers (server-side) ----------

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function getSessionTokenFromCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
