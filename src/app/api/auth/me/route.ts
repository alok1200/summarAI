import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookie,
  getSessionUser,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const token = await getSessionTokenFromCookie();
    const user = await getSessionUser(token);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 200 });
    }
    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch {
    return NextResponse.json({ user: null }, { status: 200 });
  }
}
