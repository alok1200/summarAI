import { NextRequest } from "next/server";
import { extractVideoId, fetchVideoMeta } from "@/lib/youtube-transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/youtube-meta?videoId=...  (or ?url=...)
 *
 * Returns lightweight YouTube video metadata (title, author, thumbnail) using
 * the public oEmbed endpoint. Currently unused by the chat UI (the panel that
 * consumed it was removed in favor of a simpler "paste URL → summarize" flow),
 * but kept here so future features (e.g. a video preview chip) can reuse it.
 *
 * This endpoint is NOT bot-protected (oEmbed is a public, CORS-friendly API).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const url = sp.get("url") ?? "";
  const explicitId = sp.get("videoId") ?? "";

  const videoId = explicitId || extractVideoId(url);
  if (!videoId) {
    return new Response(
      JSON.stringify({ error: "Could not extract a video ID." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const meta = await fetchVideoMeta(videoId);
  if (!meta) {
    return new Response(
      JSON.stringify({
        error:
          "Couldn't fetch metadata for this video. It may be private, deleted, or region-restricted.",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      videoId,
      title: meta.title,
      author: meta.author,
      thumbnailUrl: meta.thumbnailUrl,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
