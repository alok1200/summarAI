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
 * Strategy 2 (fallback): use youtubei.js (Innertube) WEB client with a proper
 * session and visitor data. The library manages PoTokens and visitor data
 * automatically. For some videos that block the ANDROID client, this works
 * because YouTube treats the WEB client session more like a real browser.
 */
async function fetchTranscriptViaInnertubeWeb(
  videoId: string
): Promise<TranscriptSegment[] | null> {
  const yt = await Innertube.create({
    location: "US",
    lang: "en",
    retrieve_player: false,
  });

  // Fetch video info via the WEB client. This establishes a proper session
  // with visitor data + cookies that YouTube accepts for most videos.
  const info = await yt.getInfo(videoId, { client: "WEB" });

  // Try the proper transcript API (uses engagement-panel continuation).
  try {
    const transcriptInfo = await info.getTranscript();
    const segments = transcriptInfo?.transcript?.content?.body?.initial_segments;
    if (segments && segments.length > 0) {
      const out: TranscriptSegment[] = [];
      for (const seg of segments as any[]) {
        const startMs = Number(seg.start_ms ?? 0);
        const endMs = Number(seg.end_ms ?? startMs);
        const text = (seg.snippet?.text ?? "").toString().trim();
        if (text) {
          out.push({
            start: startMs / 1000,
            dur: Math.max(0, (endMs - startMs) / 1000),
            text,
          });
        }
      }
      if (out.length > 0) return out;
    }
  } catch (e) {
    console.log(
      "[youtube-summary] Innertube getTranscript failed:",
      (e as Error).message
    );
  }

  // Fallback: pull caption track URLs from the player response and fetch them
  // directly. This still benefits from the WEB session's cookies/visitor data.
  const playerData: any = (info as any)?.page?.[0];
  const tracks =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(tracks) && tracks.length > 0) {
    return fetchAndParseCaptionTracks(tracks as CaptionTrack[]);
  }

  return null;
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
  if (html.includes('class="g-recaptcha"') || html.length < 5000) {
    throw new Error("Watch page returned CAPTCHA / blocked response");
  }
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
  // Try srv3 format first: <p t="ms" d="ms"><s>word</s>...</p>
  const srv3Regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = srv3Regex.exec(text)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const dur = parseInt(m[2], 10) / 1000;
    const inner = m[3];
    let segText = "";
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRegex.exec(inner)) !== null) {
      segText += sMatch[1];
    }
    if (!segText) segText = inner.replace(/<[^>]+>/g, "");
    segText = decodeEntities(segText).replace(/\n/g, " ").trim();
    if (segText) segments.push({ start, dur, text: segText });
  }
  if (segments.length > 0) return segments;

  // Fall back to classic format: <text start="s" dur="s">content</text>
  const xmlRegex =
    /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
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

async function fetchAndParseCaptionTracks(
  tracks: CaptionTrack[]
): Promise<TranscriptSegment[]> {
  const track = pickBestTrack(tracks);
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

  // Try each strategy in order.
  // 1. ANDROID player API (fastest, often works for non-protected videos)
  // 2. Innertube WEB client (uses proper session cookies + visitor data — best
  //    chance for videos where ANDROID gets the bot-check)
  // 3. Watch page scrape (last resort; most likely to hit 429)
  const strategies: {
    name: string;
    fn: (id: string) => Promise<TranscriptSegment[] | null> | Promise<CaptionTrack[] | null>;
    kind: "segments" | "tracks";
  }[] = [
    {
      name: "ANDROID player API",
      fn: fetchCaptionTracksViaAndroidPlayer,
      kind: "tracks",
    },
    {
      name: "Innertube WEB client",
      fn: fetchTranscriptViaInnertubeWeb,
      kind: "segments",
    },
    {
      name: "Watch page scrape",
      fn: fetchCaptionTracksViaWatchPage,
      kind: "tracks",
    },
  ];

  let lastError: Error | null = null;
  let segments: TranscriptSegment[] | null = null;

  for (const strategy of strategies) {
    try {
      console.log(`[youtube-summary] Trying ${strategy.name} for ${videoId}`);
      const result = await strategy.fn(videoId);
      if (!result) {
        console.log(
          `[youtube-summary] ✗ ${strategy.name} returned no data`
        );
        continue;
      }
      if (strategy.kind === "tracks") {
        const tracks = result as CaptionTrack[];
        if (tracks.length === 0) {
          console.log(
            `[youtube-summary] ✗ ${strategy.name} returned 0 tracks`
          );
          continue;
        }
        console.log(
          `[youtube-summary] ✓ ${strategy.name} returned ${tracks.length} tracks`
        );
        segments = await fetchAndParseCaptionTracks(tracks);
      } else {
        const segs = result as TranscriptSegment[];
        if (segs.length === 0) {
          console.log(
            `[youtube-summary] ✗ ${strategy.name} returned 0 segments`
          );
          continue;
        }
        console.log(
          `[youtube-summary] ✓ ${strategy.name} returned ${segs.length} segments`
        );
        segments = segs;
      }
      if (segments && segments.length > 0) break;
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`[youtube-summary] ✗ ${strategy.name} failed: ${msg}`);
      lastError = e as Error;
      // Small delay between strategies to avoid hammering YouTube
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (!segments || segments.length === 0) {
    const msg = lastError?.message || "";
    // Distinguish "bot blocked" from "no captions" so we can give the user
    // actionable guidance.
    if (/sign in|bot|consent|429|rate.?limit|captcha/i.test(msg)) {
      const err = new Error(
        "YouTube is asking us to sign in to confirm we're not a bot for this video. " +
          "This happens on videos with stricter bot protection (e.g. some TED talks, music videos, livestreams). " +
          "You can still get a summary by clicking 'Paste transcript manually' and pasting the transcript text from YouTube's 'Show transcript' panel."
      );
      (err as any).code = "BOT_BLOCKED";
      throw err;
    }
    throw new Error(
      "This video has no captions or transcript available, or YouTube blocked the request. " +
        "Try a different video with English captions enabled, or use the 'Paste transcript manually' option." +
        (msg ? ` (Details: ${msg})` : "")
    );
  }

  // Cache for future requests
  transcriptCache.set(videoId, {
    segments,
    fetchedAt: Date.now(),
  });

  return segments;
}

/**
 * Parse a user-pasted transcript. Accepts several formats:
 *   - "MM:SS text" or "HH:MM:SS text" (one per line)
 *   - "[MM:SS] text"
 *   - "1:23:45 text"
 *   - Plain text (no timestamps) — each non-empty line becomes a segment
 *     with a sequential 5-second offset.
 *
 * Returns both the segments AND whether any line had a real timestamp, so the
 * caller can decide whether time-range filtering is meaningful. If the user
 * pasted plain text without timestamps, applying a time-range filter would
 * silently drop everything (since all auto-generated timestamps start near 0),
 * which is almost never what they want.
 */
function parseUserTranscript(raw: string): {
  segments: TranscriptSegment[];
  hasTimestamps: boolean;
} {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { segments: [], hasTimestamps: false };

  const segments: TranscriptSegment[] = [];
  let lastStart = 0;
  let hasTimestamps = false;
  const tsRegex = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.*)$/;

  for (const line of lines) {
    const m = line.match(tsRegex);
    if (m) {
      const parts = m[1].split(":").map((p) => parseInt(p, 10));
      let sec: number;
      if (parts.length === 2) sec = parts[0] * 60 + parts[1];
      else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else sec = 0;
      lastStart = sec;
      hasTimestamps = true;
      if (m[2]) {
        segments.push({ start: sec, dur: 5, text: m[2].trim() });
      }
    } else {
      // No timestamp: use lastStart + small increment
      segments.push({ start: lastStart, dur: 5, text: line });
      lastStart += 5;
    }
  }

  return { segments, hasTimestamps };
}

/**
 * Build the streaming summary response from a list of transcript segments.
 */
async function streamSummary(
  videoId: string | null,
  url: string,
  actualStartTime: number,
  actualEndTime: number,
  filteredCount: number,
  instructions: string,
  transcriptText: string,
  isManual: boolean,
  rangeNote?: string
) {
  const durationSec = actualEndTime - actualStartTime;

  const systemPrompt =
    "You are a helpful AI assistant that summarizes YouTube video transcripts. " +
    "The user has selected a specific time range from the video. " +
    "Produce a clear, well-structured summary with: a one-paragraph overview, " +
    "the key points as a bulleted list (referencing timestamps where useful), " +
    "and any notable quotes or insights. Use Markdown. " +
    "Do not invent information that isn't in the transcript.";

  const userMessage =
    `Please summarize the following YouTube video transcript.\n\n` +
    `Video URL: ${url}\n` +
    `Selected time range: ${formatTime(actualStartTime)} – ${formatTime(
      actualEndTime
    )}  (about ${Math.round(durationSec)}s, ${filteredCount} segments)\n\n` +
    (instructions
      ? `Additional instructions from the user: ${instructions}\n\n`
      : "") +
    `Transcript (with timestamps):\n\n${transcriptText}\n\n` +
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

  const sourceLabel = isManual ? " (manual paste)" : "";
  const header =
    `**▶️ YouTube Video Summary${sourceLabel}**\n\n` +
    `**URL:** ${url}\n` +
    `**Time range:** ${formatTime(actualStartTime)} – ${formatTime(
      actualEndTime
    )}  ·  ${filteredCount} transcript segments\n` +
    (rangeNote ? `**Note:** ${rangeNote}\n` : "") +
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
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url: string = body.url ?? "";
    const startTimeStr: string = body.startTime ?? "";
    const endTimeStr: string = body.endTime ?? "";
    const instructions: string = (body.instructions ?? "").trim();
    // Optional: user-pasted transcript. When provided, we skip fetching.
    const manualTranscript: string = (body.transcript ?? "").trim();

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

    let allSegments: TranscriptSegment[];
    let isManual = false;
    // For manual pastes that contained no timestamps, time-range filtering
    // doesn't make sense (every segment was assigned a synthetic 5s-offset
    // timestamp starting from 0, so any non-trivial start time would drop
    // everything). We remember this flag and skip the filter below.
    let skipTimeFilter = false;

    if (manualTranscript) {
      // User provided their own transcript — skip the YouTube fetch entirely.
      const { segments: parsed, hasTimestamps } =
        parseUserTranscript(manualTranscript);
      if (parsed.length === 0) {
        return jsonResponse(400, {
          error:
            "Couldn't find any transcript text in your paste. Please paste at least one line of the transcript.",
        });
      }
      allSegments = parsed;
      isManual = true;
      if (!hasTimestamps && (startTime !== undefined || endTime !== undefined)) {
        // The user pasted plain text but asked for a time range. We can't
        // meaningfully filter plain text by time, so we summarize the whole
        // paste and tell them about it in the summary header.
        skipTimeFilter = true;
      }
    } else {
      allSegments = await fetchTranscriptWithRetry(videoId);
    }

    // Apply time-range filter (skipped for plain-text manual pastes).
    let filtered = skipTimeFilter
      ? allSegments
      : allSegments.filter((s) => {
          if (startTime !== undefined && s.start < startTime) return false;
          if (endTime !== undefined && s.start >= endTime) return false;
          return true;
        });

    let rangeNote: string | undefined;
    if (skipTimeFilter) {
      rangeNote =
        "Time range was ignored because the pasted transcript has no timestamps — summarized the whole paste instead.";
    } else if (filtered.length === 0 && allSegments.length > 0) {
      // The user asked for a specific time range, but no transcript segments
      // fall within it. Instead of returning a frustrating error that blocks
      // their workflow, fall back to summarizing the WHOLE transcript with a
      // clear note explaining what happened. The user always gets a useful
      // summary; they can refine the time range on a subsequent attempt if
      // needed.
      filtered = allSegments;
      const totalSegs = allSegments.length;
      const firstStart = Math.floor(allSegments[0].start);
      const lastStart = Math.floor(allSegments[totalSegs - 1].start);
      const rangeLabel =
        startTime !== undefined && endTime !== undefined
          ? `${formatTime(startTime)} – ${formatTime(endTime)}`
          : startTime !== undefined
          ? `after ${formatTime(startTime)}`
          : endTime !== undefined
          ? `before ${formatTime(endTime)}`
          : "(no range)";
      rangeNote =
        `No segments were found in your requested range (${rangeLabel}), so the whole transcript ` +
        `(${formatTime(firstStart)} – ${formatTime(lastStart)}, ${totalSegs} segments) was summarized instead. ` +
        `Adjust the time range to overlap with the transcript and try again for a more targeted summary.`;
    }

    const actualStartTime = filtered[0].start;
    const lastSeg = filtered[filtered.length - 1];
    const actualEndTime = lastSeg.start + lastSeg.dur;

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

    return await streamSummary(
      videoId,
      url || `https://www.youtube.com/watch?v=${videoId}`,
      actualStartTime,
      actualEndTime,
      filtered.length,
      instructions,
      truncated,
      isManual,
      rangeNote
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = (err as any)?.code;
    console.error("[youtube-summary] error:", message, "code:", code);
    // Return 403 with BOT_BLOCKED so the UI can offer the manual paste option.
    if (code === "BOT_BLOCKED") {
      return jsonResponse(403, { error: message, code: "BOT_BLOCKED" });
    }
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
