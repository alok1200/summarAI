import { NextRequest, NextResponse } from "next/server";
import {
  getSessionTokenFromCookie,
  getSessionUser,
} from "@/lib/auth";
import type { User } from "@prisma/client";

export const runtime = "nodejs";

/**
 * Authentication guard for protected API routes.
 *
 * Returns one of:
 *   - { ok: true,  user: User }           — caller is authenticated, proceed
 *   - { ok: false, response: NextResponse } — caller is NOT authenticated;
 *     the route handler should `return guard.response` immediately.
 *
 * Usage:
 *   export async function POST(req: NextRequest) {
 *     const guard = await requireAuth(req);
 *     if (!guard.ok) return guard.response;
 *     const user = guard.user;  // typed as User
 *     ...
 *   }
 *
 * Why a helper instead of a higher-order wrapper?
 *   Next.js route handlers must be exported as `POST`/`GET`/etc — wrapping
 *   them would break the export signature. A guard helper is the idiomatic
 *   pattern in Next 14/15/16.
 */
export async function requireAuth(
  _req: NextRequest
): Promise<
  | { ok: true; user: Pick<User, "id" | "email" | "name"> }
  | { ok: false; response: NextResponse }
> {
  try {
    const token = await getSessionTokenFromCookie();
    const user = await getSessionUser(token);
    if (!user) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Authentication required. Please sign in." },
          { status: 401 }
        ),
      };
    }
    return {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
    };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Authentication check failed. Please sign in again." },
        { status: 401 }
      ),
    };
  }
}
