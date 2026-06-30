import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookie,
  destroySession,
  clearSessionCookie,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const token = await getSessionTokenFromCookie();
    await destroySession(token);
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Logout failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
