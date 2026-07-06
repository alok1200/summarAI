import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/email-direct/enabled
 *
 * Returns `{ enabled: boolean }` so the frontend can decide whether to
 * render the "Continue with Email" button.
 */
export async function GET() {
  const enabled =
    process.env.ENABLE_EMAIL_DIRECT ??
    (process.env.NODE_ENV === "production" ? "false" : "true");
  return NextResponse.json(
    { enabled: enabled === "true" || enabled === "1" },
    {
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}
