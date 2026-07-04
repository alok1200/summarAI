/**
 * Shared YouTube transcript fetcher.
 *
 * Used by both `/api/youtube-summary` and `/api/youtube-interview` so that any
 * improvement to the multi-strategy fetcher benefits both endpoints.
 *
 * Strategies (tried in order):
 *   1. InnerTube ANDROID player API      — bypasses JS challenges
 *   2. Watch-page HTML scrape            — works for many public videos
 *   3. youtube-transcript npm package     — different fingerprint
 *   4. youtubei.js (Innertube WEB)       — maintained library fallback
 *
 * If any strategy reports a bot-block signature, the final error is classified
 * as BOT_BLOCKED so the caller can surface a "paste transcript manually" UI.
 */

export interface TranscriptSegment {
  start: number; // seconds
  dur: number; // seconds
  text: string;
}

export interface VideoMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
}

export interface BotBlockedError extends Error {
  code: "BOT_BLOCKED";
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// In-memory caches
interface CacheEntry {
  segments: TranscriptSegment[];
  fetchedAt: number;
}
const transcriptCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

interface MetaCacheEntry extends VideoMeta {
  fetchedAt: number;
}
const metaCache = new Map<string, MetaCacheEntry>();
const META_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

export function extractVideoId(url: string): string | null {
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

export function parseTimeString(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

export function formatTime(s: number): string {
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
 * Fetch lightweight video metadata (title, author, thumbnail) via YouTube's
 * public oEmbed endpoint. NOT bot-protected.
 */
export async function fetchVideoMeta(
  videoId: string
): Promise<VideoMeta | null> {
  const cached = metaCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached;
  }
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!json.title) return null;
    const entry: MetaCacheEntry = {
      title: json.title,
      author: json.author_name || "Unknown",
      thumbnailUrl:
        json.thumbnail_url ||
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      fetchedAt: Date.now(),
    };
    metaCache.set(videoId, entry);
    return entry;
  } catch {
    return null;
  }
}

// Strategy 1: InnerTube ANDROID player API
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

// Strategy 2: scrape the watch page HTML
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

// Strategy 3: youtube-transcript npm package
async function fetchTranscriptViaYoutubeTranscriptLib(
  videoId: string
): Promise<TranscriptSegment[] | null> {
  try {
    const mod = await import("youtube-transcript");
    const result = await mod.YoutubeTranscript.fetchTranscript(videoId, {
      lang: "en",
    });
    if (!Array.isArray(result) || result.length === 0) return null;
    return result
      .map((r) => ({
        start: r.offset ?? 0,
        dur: r.duration ?? 0,
        text: (r.text || "").replace(/\n/g, " ").trim(),
      }))
      .filter((s) => s.text.length > 0);
  } catch (e) {
    const msg = (e as Error)?.message || "";
    throw new Error(`youtube-transcript lib: ${msg}`);
  }
}

// Strategy 4: youtubei.js (Innertube WEB)
async function fetchTranscriptViaInnertube(
  videoId: string
): Promise<TranscriptSegment[] | null> {
  try {
    const mod = await import("youtubei.js");
    const Innertube = mod.default;
    const yt = await Innertube.create();
    const info = await yt.getInfo(videoId);
    const transcriptInfo = await info.getTranscript();
    const body = transcriptInfo?.transcript?.content?.body;
    const rawSegments: any[] = (body as any)?.initial_segments ?? [];
    if (rawSegments.length === 0) return null;
    const segments: TranscriptSegment[] = [];
    for (const s of rawSegments) {
      if (typeof s.start_ms === "undefined") continue;
      const startMs = parseInt(s.start_ms ?? "0", 10);
      const endMs = parseInt(s.end_ms ?? "0", 10);
      const text: string = s.snippet?.text ?? "";
      const cleaned = String(text).replace(/\n/g, " ").trim();
      if (cleaned.length > 0) {
        segments.push({
          start: startMs / 1000,
          dur: Math.max(0, (endMs - startMs) / 1000),
          text: cleaned,
        });
      }
    }
    return segments.length > 0 ? segments : null;
  } catch (e) {
    const msg = (e as Error)?.message || "";
    throw new Error(`youtubei.js: ${msg}`);
  }
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

/**
 * Try multiple strategies in order to fetch the transcript. Each strategy
 * has different bot-detection characteristics.
 *
 * Throws a `BotBlockedError` (with `code === "BOT_BLOCKED"`) if any strategy
 * reported a bot-block signature. Throws a generic Error otherwise.
 */
export async function fetchTranscriptWithRetry(
  videoId: string
): Promise<TranscriptSegment[]> {
  const cached = transcriptCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.segments;
  }

  const trackStrategies: {
    name: string;
    fn: (id: string) => Promise<CaptionTrack[] | null>;
  }[] = [
    {
      name: "ANDROID player API",
      fn: fetchCaptionTracksViaAndroidPlayer,
    },
    {
      name: "Watch page scrape",
      fn: fetchCaptionTracksViaWatchPage,
    },
  ];

  const directStrategies: {
    name: string;
    fn: (id: string) => Promise<TranscriptSegment[] | null>;
  }[] = [
    {
      name: "youtube-transcript library",
      fn: fetchTranscriptViaYoutubeTranscriptLib,
    },
    {
      name: "youtubei.js (Innertube)",
      fn: fetchTranscriptViaInnertube,
    },
  ];

  let lastError: Error | null = null;
  let botBlockedSeen = false;
  let segments: TranscriptSegment[] | null = null;

  for (const strategy of trackStrategies) {
    try {
      console.log(`[youtube] Trying ${strategy.name} for ${videoId}`);
      const tracks = await strategy.fn(videoId);
      if (!tracks || tracks.length === 0) {
        console.log(`[youtube] ✗ ${strategy.name} returned no tracks`);
        continue;
      }
      console.log(
        `[youtube] ✓ ${strategy.name} returned ${tracks.length} tracks`
      );
      segments = await fetchAndParseCaptionTracks(tracks);
      if (segments.length > 0) break;
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`[youtube] ✗ ${strategy.name} failed: ${msg}`);
      if (/sign in|bot|consent|429|rate.?limit|captcha|too many requests/i.test(msg)) {
        botBlockedSeen = true;
        lastError = e as Error;
      } else if (!botBlockedSeen) {
        lastError = e as Error;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (!segments || segments.length === 0) {
    for (const strategy of directStrategies) {
      try {
        console.log(`[youtube] Trying ${strategy.name} for ${videoId}`);
        const result = await strategy.fn(videoId);
        if (!result || result.length === 0) {
          console.log(`[youtube] ✗ ${strategy.name} returned no segments`);
          continue;
        }
        console.log(
          `[youtube] ✓ ${strategy.name} returned ${result.length} segments`
        );
        segments = result;
        break;
      } catch (e) {
        const msg = (e as Error).message;
        console.log(`[youtube] ✗ ${strategy.name} failed: ${msg}`);
        if (/sign in|bot|consent|429|rate.?limit|captcha|too many requests/i.test(msg)) {
          botBlockedSeen = true;
          lastError = e as Error;
        } else if (!botBlockedSeen) {
          lastError = e as Error;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  if (!segments || segments.length === 0) {
    if (botBlockedSeen) {
      const friendlyMessage =
        "YouTube is asking us to sign in to confirm we're not a bot for this video. " +
        "This happens on videos with stricter bot protection (e.g. some TED talks, music videos, livestreams). " +
        "You can still get your result by clicking 'Paste transcript manually' and pasting the transcript text from YouTube's 'Show transcript' panel.";
      const err = new Error(friendlyMessage) as BotBlockedError;
      err.code = "BOT_BLOCKED";
      throw err;
    }
    const msg = lastError?.message || "";
    throw new Error(
      "This video has no captions or transcript available, or YouTube blocked the request. " +
        "Try a different video with English captions enabled, or use the 'Paste transcript manually' option." +
        (msg ? ` (Details: ${msg})` : "")
    );
  }

  transcriptCache.set(videoId, {
    segments,
    fetchedAt: Date.now(),
  });

  return segments;
}

/**
 * Parse a user-pasted transcript. Accepts:
 *   - "MM:SS text" or "HH:MM:SS text" (one per line)
 *   - "[MM:SS] text"
 *   - "1:23:45 text"
 *   - Plain text (no timestamps) — each non-empty line becomes a segment
 *     with a sequential 5-second offset.
 */
export function parseUserTranscript(raw: string): {
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
      segments.push({ start: lastStart, dur: 5, text: line });
      lastStart += 5;
    }
  }

  return { segments, hasTimestamps };
}
