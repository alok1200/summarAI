import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api
 *
 * Service descriptor. Returns the app name, version, and a list of
 * available endpoints. Useful for:
 *   - Operators hitting the root in a browser to confirm the service is up
 *   - Discovery tooling that walks /api to see what's deployed
 *   - A sanity check that the build deployed the right version
 *
 * Health probes should use /api/health (which also pings the DB);
 * this endpoint is intentionally cheap (no DB call) so it works even
 * during a DB outage.
 */
export async function GET() {
  return NextResponse.json(
    {
      name: "SummarAI",
      version: "1.0.0",
      description:
        "Chat + YouTube transcript summarizer + interview Q&A generator.",
      endpoints: [
        "POST /api/auth/signup",
        "POST /api/auth/login",
        "POST /api/auth/logout",
        "GET  /api/auth/me",
        "POST /api/chat              (auth required, rate-limited)",
        "POST /api/youtube-summary   (auth required, rate-limited)",
        "POST /api/youtube-interview (auth required, rate-limited)",
        "POST /api/youtube-load      (auth required, rate-limited)",
        "GET  /api/youtube-meta?videoId=...|url=...",
        "GET  /api/health            (liveness + DB readiness probe)",
      ],
      docs: "See README.md for full API documentation.",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
