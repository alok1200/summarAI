import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { Innertube } from "youtubei.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TranscriptSegment {
  start: number; // seconds
  dur: number; // seconds
  text: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// In-memory cache: videoId+range -> { segments, fetchedAt }
// Avoids re-fetching transcript when the user retries a failed summary.
interface CacheEntry {
  segments: TranscriptSegment[];
  fetchedAt: number;
}
const transcriptCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

function extractVideoId(url: string): string | null {
  const patterns: RegExp[] = [
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function parseTimeString(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

interface CaptionTrack {
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
  baseUrl: string;
}

/**
 * Strategy 1 (most reliable): use YouTube's internal `youtubei/v1/player` API
 * with the ANDROID client identity. This bypasses most "Sign in to confirm
 * you're not a bot" blocks because YouTube trusts requests from its own
 * Android app.
 */
async function fetchCaptionTracksViaAndroidPlayer(
  videoId: string
): Promise<CaptionTrack[] | null> {
  const body = {
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
    videoId,
  };

  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "User-Agent":
          "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    throw new Error(`YouTube ANDROID player API returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const playability = json?.playabilityStatus;
  if (
    playability?.status !== "OK" &&
    playability?.status !== "LIVE_STREAM_OFFLINE"
  ) {
    const reason =
      playability?.reason ||
      playability?.messages?.[0] ||
      playability?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText;
    throw new Error(
      reason || "This video cannot be accessed via the YouTube API."
    );
  }

  const tracks =
    json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? (tracks as CaptionTrack[]) : null;
}

/**
 * Strategy 2 (fallback): use youtubei.js (Innertube) which uses the WEB
 * client with proper session cookies. Better for some region-restricted
 * videos that the ANDROID client can't access.
 */
async function fetchCaptionTracksViaInnertube(
  videoId: string
): Promise<CaptionTrack[] | null> {
  const yt = await Innertube.create({
    location: "US",
    lang: "en",
    retrieve_player: false,
  });

  // Use the Innertube session's http client to call the player API directly
  // (this gives us proper session cookies + visitor data that bypass some
  // bot checks).
  const response = await yt.session.http.fetch("player", {
    method: "POST",
    body: JSON.stringify({
      context: yt.session.context,
      videoId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Innertube player API returned HTTP ${response.status}`);
  }

  const data: any = await response.json();
  const playability = data?.playabilityStatus;
  if (playability?.status !== "OK" && playability?.status !== "LIVE_STREAM_OFFLINE") {
    throw new Error(
      playability?.reason || "Video is unplayable via the WEB client."
    );
  }

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? (tracks as CaptionTrack[]) : null;
}

/**
 * Strategy 3 (last resort): scrape the watch page HTML. Works for many public
 * videos but is the most likely to hit "Sign in to confirm you're not a bot".
 */
async function fetchCaptionTracksViaWatchPage(
  videoId: string
): Promise<CaptionTrack[] | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Watch page returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:var\s|const\s|let\s|<\/script>|$)/
  );
  if (!match) {
    throw new Error(
      "Could not find player data on the watch page (YouTube may have changed its HTML structure)."
    );
  }

  const playerResponse = JSON.parse(match[1]);
  const playability = playerResponse?.playabilityStatus;
  if (
    playability?.status === "ERROR" ||
    playability?.status === "LOGIN_REQUIRED"
  ) {
    throw new Error(
      playability?.reason ||
        "This video cannot be accessed (private, age-restricted, or unavailable)."
    );
  }

  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) && tracks.length > 0
    ? (tracks as CaptionTrack[])
    : null;
}

function pickBestTrack(tracks: CaptionTrack[]): CaptionTrack {
  const enManual = tracks.find(
    (t) => t.languageCode === "en" && t.kind !== "asr"
  );
  const enAuto = tracks.find(
    (t) => t.languageCode === "en" && t.kind === "asr"
  );
  return enManual || enAuto || tracks[0];
}

function normalizeTrackUrl(url: string): string {
  // Force JSON3 format for reliable parsing.
  if (url.includes("fmt=")) {
    return url.replace(/fmt=[^&]+/, "fmt=json3");
  }
  return url + (url.includes("?") ? "&" : "?") + "fmt=json3";
}

function parseJson3Transcript(text: string): TranscriptSegment[] {
  const json = JSON.parse(text);
  if (!Array.isArray(json.events)) return [];
  return json.events
    .filter(
      (e: any) => e.segs && Array.isArray(e.segs) && e.segs.length > 0
    )
    .map((e: any) => ({
      start: (e.tStartMs ?? 0) / 1000,
      dur: (e.dDurationMs ?? 0) / 1000,
      text: e.segs
        .map((s: any) => (typeof s.utf8 === "string" ? s.utf8 : ""))
        .join("")
        .replace(/\n/g, " ")
        .trim(),
    }))
    .filter((s: TranscriptSegment) => s.text.length > 0);
}

function parseXmlTranscript(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const xmlRegex =
    /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = xmlRegex.exec(text)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const segText = decodeEntities(m[3])
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .trim();
    if (segText) segments.push({ start, dur, text: segText });
  }
  return segments;
}

async function fetchTranscriptWithRetry(
  videoId: string
): Promise<TranscriptSegment[]> {
  // Check cache first
  const cached = transcriptCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.segments;
  }

  // Try each strategy in order. The ANDROID player API is the most reliable
  // against "Sign in to confirm you're not a bot" checks.
  const strategies: {
    name: string;
    fn: (id: string) => Promise<CaptionTrack[] | null>;
  }[] = [
    { name: "ANDROID player API", fn: fetchCaptionTracksViaAndroidPlayer },
    { name: "Innertube (WEB client)", fn: fetchCaptionTracksViaInnertube },
    { name: "Watch page scrape", fn: fetchCaptionTracksViaWatchPage },
  ];

  let lastError: Error | null = null;
  let captionTracks: CaptionTrack[] | null = null;

  for (const strategy of strategies) {
    try {
      console.log(`[youtube-summary] Trying ${strategy.name} for ${videoId}`);
      captionTracks = await strategy.fn(videoId);
      if (captionTracks && captionTracks.length > 0) {
        console.log(
          `[youtube-summary] ✓ ${strategy.name} returned ${captionTracks.length} caption tracks`
        );
        break;
      }
    } catch (e) {
      console.log(`[youtube-summary] ✗ ${strategy.name} failed:`, (e as Error).message);
      lastError = e as Error;
      // Small delay between strategies to avoid hammering YouTube
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    const msg = lastError?.message || "";
    // Distinguish "bot blocked" from "no captions" so we can give the user
    // actionable guidance.
    if (/sign in|bot|consent|429|rate.?limit/i.test(msg)) {
      throw new Error(
        "YouTube is currently asking this server to 'sign in to confirm you're not a bot'. " +
          "This is a transient block on YouTube's side. Please try again in a few minutes, " +
          "or try a different video. (Underlying error: " + msg + ")"
      );
    }
    throw new Error(
      "This video has no captions or transcript available, or YouTube blocked the request. " +
        "Try a different video with English captions enabled." +
        (msg ? ` (Details: ${msg})` : "")
    );
  }

  const track = pickBestTrack(captionTracks);
  const trackUrl = normalizeTrackUrl(track.baseUrl);

  const captionRes = await fetch(trackUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!captionRes.ok) {
    throw new Error(`Failed to fetch captions (HTTP ${captionRes.status}).`);
  }
  const captionText = await captionRes.text();

  let segments: TranscriptSegment[] = [];
  if (captionText.trim().startsWith("{")) {
    try {
      segments = parseJson3Transcript(captionText);
    } catch {
      // fall through to XML
    }
  }
  if (segments.length === 0) {
    segments = parseXmlTranscript(captionText);
  }
  if (segments.length === 0) {
    throw new Error(
      "Could not parse the transcript. The caption format may be unsupported."
    );
  }

  // Cache for future requests
  transcriptCache.set(videoId, {
    segments,
    fetchedAt: Date.now(),
  });

  return segments;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url: string = body.url ?? "";
    const startTimeStr: string = body.startTime ?? "";
    const endTimeStr: string = body.endTime ?? "";
    const instructions: string = (body.instructions ?? "").trim();

    const videoId = extractVideoId(url);
    if (!videoId) {
      return jsonResponse(400, {
        error:
          "Could not extract a video ID from this URL. Please paste a YouTube link like https://www.youtube.com/watch?v=…",
      });
    }

    const startTime = parseTimeString(startTimeStr);
    const endTime = parseTimeString(endTimeStr);

    if (
      startTime !== undefined &&
      endTime !== undefined &&
      startTime >= endTime
    ) {
      return jsonResponse(400, {
        error: "Start time must be earlier than end time.",
      });
    }

    const allSegments = await fetchTranscriptWithRetry(videoId);

    const filtered = allSegments.filter((s) => {
      if (startTime !== undefined && s.start < startTime) return false;
      if (endTime !== undefined && s.start >= endTime) return false;
      return true;
    });

    if (filtered.length === 0) {
      return jsonResponse(400, {
        error:
          "No transcript segments were found in the requested time range. Check the timestamps and try again.",
      });
    }

    const actualStartTime = filtered[0].start;
    const lastSeg = filtered[filtered.length - 1];
    const actualEndTime = lastSeg.start + lastSeg.dur;
    const durationSec = actualEndTime - actualStartTime;

    const transcriptText = filtered
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join("\n");

    // Truncate to ~80k chars to avoid token overflow
    const MAX_CHARS = 80000;
    const truncated =
      transcriptText.length > MAX_CHARS
        ? transcriptText.slice(0, MAX_CHARS) +
          "\n\n[... transcript truncated due to length ...]"
        : transcriptText;

    const systemPrompt =
      "You are a helpful AI assistant that summarizes YouTube video transcripts. " +
      "The user has selected a specific time range from the video. " +
      "Produce a clear, well-structured summary with: a one-paragraph overview, " +
      "the key points as a bulleted list (referencing timestamps where useful), " +
      "and any notable quotes or insights. Use Markdown. " +
      "Do not invent information that isn't in the transcript.";

    const userMessage =
      `Please summarize the following YouTube video transcript.\n\n` +
      `Video URL: https://www.youtube.com/watch?v=${videoId}\n` +
      `Selected time range: ${formatTime(actualStartTime)} – ${formatTime(
        actualEndTime
      )}  (about ${Math.round(durationSec)}s, ${filtered.length} segments)\n\n` +
      (instructions
        ? `Additional instructions from the user: ${instructions}\n\n`
        : "") +
      `Transcript (with timestamps):\n\n${truncated}\n\n` +
      `Please provide your structured summary now.`;

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      thinking: { type: "disabled" },
    });

    const content: string =
      completion?.choices?.[0]?.message?.content ??
      "Sorry, I couldn't generate a summary for this video.";

    const header =
      `**▶️ YouTube Video Summary**\n\n` +
      `**URL:** https://www.youtube.com/watch?v=${videoId}\n` +
      `**Time range:** ${formatTime(actualStartTime)} – ${formatTime(
        actualEndTime
      )}  ·  ${filtered.length} transcript segments\n` +
      (instructions ? `**Your instructions:** ${instructions}\n` : "") +
      `\n---\n\n`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const tok of header.match(/\s+|\S+/g) ?? [header]) {
          controller.enqueue(encoder.encode(tok));
          await new Promise((r) => setTimeout(r, 4));
        }
        const tokens = content.match(/\s+|\S+/g) ?? [content];
        for (const token of tokens) {
          controller.enqueue(encoder.encode(token));
          await new Promise((r) => setTimeout(r, 12));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[youtube-summary] error:", message);
    return jsonResponse(500, {
      error: message || "YouTube summary failed.",
    });
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
