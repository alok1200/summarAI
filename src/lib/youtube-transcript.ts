/**
 * Shared YouTube transcript fetcher.
 *
 * Used by both `/api/youtube-summary` and `/api/youtube-interview` so that any
 * improvement to the multi-strategy fetcher benefits both endpoints.
 *
 * Strategies (tried in order):
 *   1. InnerTube ANDROID player API      — bypasses JS challenges (20.10.38)
 *   2. Watch-page HTML scrape            — works for many public videos
 *   3. youtube-transcript npm package     — different fingerprint
 *   4. youtubei.js (Innertube WEB)       — maintained library fallback
 *
 * All strategies reuse a warmed cookie jar (CONSENT + VISITOR_INFO1_LIVE) so
 * YouTube treats them as a returning browser session rather than a cold bot.
 * A 1.5s backoff is used between strategies when a 429 / "Sign in" / captcha
 * signature is detected, giving YouTube's rate-limiter time to cool down.
 *
 * If any strategy reports a bot-block signature, the final error is classified
 * as BOT_BLOCKED so the caller can surface a graceful "try again later"
 * message — the manual-paste fallback was removed from the UI.
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

/**
 * Warmed cookie jar — fetched ONCE per process (and refreshed if older than
 * 10 min). YouTube sets `CONSENT` and `VISITOR_INFO1_LIVE` cookies on the
 * first request to youtube.com; subsequent requests that carry these cookies
 * look like a returning browser session, which dramatically reduces the
 * chance of getting a 429 / "Sign in to confirm you're not a bot" response.
 */
interface CookieJar {
  cookieHeader: string; // e.g. "CONSENT=YES+; VISITOR_INFO1_LIVE=abc"
  fetchedAt: number;
}
let warmedCookies: CookieJar | null = null;
const COOKIE_TTL_MS = 1000 * 60 * 10; // 10 minutes

async function warmCookies(): Promise<string> {
  if (warmedCookies && Date.now() - warmedCookies.fetchedAt < COOKIE_TTL_MS) {
    return warmedCookies.cookieHeader;
  }
  try {
    const res = await fetch("https://www.youtube.com/", {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const pairs: string[] = [];
    for (const sc of setCookies) {
      const m = sc.match(/^([^=]+)=([^;]+)/);
      if (m) pairs.push(`${m[1]}=${m[2]}`);
    }
    const header = pairs.length > 0 ? pairs.join("; ") : "";
    warmedCookies = { cookieHeader: header, fetchedAt: Date.now() };
    console.log(
      `[youtube] Warmed ${pairs.length} cookies: ${pairs
        .map((p) => p.split("=")[0])
        .join(", ")}`
    );
    return header;
  } catch {
    // Cookie warming is best-effort — strategies still work without it,
    // just with a higher block rate.
    return "";
  }
}

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
  // Support optional "m" / "s" / "h" unit suffixes for explicit input, e.g.:
  //   "5m"     → 5 minutes        "90s"   → 90 seconds
  //   "1h"     → 1 hour           "1h30m" → 1h30m
  //   "2h15m30s" → 2h15m30s       "1h 30m" → 1h30m (spaces ok)
  // These always win over the bare-number rule below.
  if (/[hms]/i.test(trimmed) && /^[\d\s.:hms]+$/i.test(trimmed)) {
    const h = trimmed.match(/(\d+)\s*h/i);
    const m = trimmed.match(/(\d+)\s*m/i);
    const sec = trimmed.match(/(\d+)\s*s/i);
    if (h || m || sec) {
      let total = 0;
      if (h) total += parseInt(h[1], 10) * 3600;
      if (m) total += parseInt(m[1], 10) * 60;
      if (sec) total += parseInt(sec[1], 10);
      return total;
    }
  }
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  // BARE NUMBER → MINUTES (so "5" means 5 min, not 5 sec).
  // This matches how a human naturally thinks about video timestamps:
  // "skip to 5" = the 5-minute mark, not 5 seconds in.
  if (parts.length === 1) return parts[0] * 60;
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

/**
 * Shared instructions injected into every YouTube LLM prompt so the AI always
 * cites timestamps the SAME way — by COPYING them verbatim from the transcript,
 * not by inventing or reformatting them.
 *
 * This is the fix for "AI not providing timeline properly":
 *   - The transcript already shows timestamps in M:SS (short videos) or
 *     H:MM:SS (long videos) format. The LLM was previously told to always
 *     use [MM:SS], which conflicted with the transcript for hour-plus videos
 *     and caused it to drop or hallucinate timestamps.
 *   - Now we tell it: copy the timestamp EXACTLY as it appears in the
 *     transcript, in square brackets, and never invent one.
 */
export const TIMESTAMP_RULES =
  `TIMESTAMP CITATION RULES (very important):\n` +
  `- The transcript is prefixed with timestamps like [3:25] or [1:25:30]. ` +
  `ALWAYS copy the timestamp EXACTLY as it appears in the transcript — same digits, same format.\n` +
  `- For videos under 1 hour, timestamps look like [M:SS] (e.g. [3:25], [12:08]). ` +
  `For videos 1 hour or longer, they look like [H:MM:SS] (e.g. [1:25:30], [2:05:14]). ` +
  `Match whatever format you see in the transcript — do NOT convert between them.\n` +
  `- NEVER invent a timestamp that doesn't appear in the transcript. If you're unsure ` +
  `which timestamp to cite, find the closest one in the transcript and use that.\n` +
  `- Every major claim, definition, example, demo, quote, or notable moment MUST be ` +
  `followed by its [timestamp] in square brackets so the user can jump to that moment.\n` +
  `- When covering a topic that spans a range of time, cite the range like ` +
  `[3:25]–[7:48] (using an en-dash). For a single moment, cite a single [timestamp].\n` +
  `- In the Chapter Index (or any "jump to" list), list time ranges as ` +
  `[start]–[end] with a short title, e.g. "[3:25]–[7:48] React hooks intro".`;

/**
 * Shared instructions that define EXACTLY what a good TL;DR looks like.
 *
 * The previous TL;DR instruction asked for "4-6 sentences naming every topic"
 * which produced a wall-of-text paragraph that nobody wanted to read. A real
 * TL;DR is short, scannable, and gives the bottom line — it is NOT a list of
 * every topic (that's what the Detailed Breakdown is for).
 *
 * This format is enforced across:
 *   - /api/youtube-summary short-video prompt
 *   - /api/youtube-summary MAP / SECTION / REDUCE prompts
 *   - /api/youtube-interview system prompt
 *   - /api/chat (ask-about-video) system prompt
 *
 * Format: 1 punchy bottom-line sentence + 3-5 bold scannable bullets + 1-line
 * "best for" audience note. No walls of text.
 */
export const TLDR_FORMAT =
  `\n\nTL;DR FORMAT (mandatory — do NOT turn this into a wall of text):\n` +
  `The "## TL;DR" section MUST follow this exact shape:\n` +
  `1. ONE opening sentence (≤ 25 words) that states the bottom line — what the video is about and why it matters. ` +
  `Do NOT list every topic here; just say the single most important thing.\n` +
  `2. Then 3–5 bold bullets, each ≤ 15 words, capturing the key takeaways. ` +
  `Each bullet = ONE concrete insight, finding, or recommendation — NOT a topic name.\n` +
  `3. End with one italic line: "_Best for: <who should watch this video, e.g. beginners / React devs / data engineers>_."\n\n` +
  `Example of a GOOD TL;DR:\n` +
  `   ## TL;DR\n` +
  `   A 30-minute deep-dive into React Server Components — what they are, when to use them, and the gotchas the docs don't mention.\n\n` +
  `   - **RSC renders on the server, ships zero JS to the client** — biggest perf win for content-heavy pages.\n` +
  `   - **'use client' is opt-in per file** — defaults are server, mark client only when you need state/effects.\n` +
  `   - **Data fetching belongs in async server components** — no more useEffect + fetch boilerplate.\n` +
  `   - **Watch out: context doesn't cross the server/client boundary** — pass props or use a provider.\n` +
  `   - **Next.js App Router = RSC by default** — migrating from Pages Router is the easiest way to try them.\n\n` +
  `   _Best for: React developers familiar with hooks who want to understand the App Router's mental model._\n\n` +
  `DO NOT write a 4-6 sentence paragraph. DO NOT list every topic — that's what the Detailed Breakdown is for. ` +
  `Keep it punchy, scannable, and useful in 10 seconds.`;

/**
 * Shared instructions that force the AI to produce a DENSE, COMPLETE
 * minute-by-minute timeline of the video — covering every 1–5 minute
 * interval so the user can jump to any moment and understand what's there.
 *
 * This is the answer to "provide all timestamps like 1min to 5min — provide
 * all details": the AI must walk through the ENTIRE video, picking the most
 * informative timestamp in every ~1–5 minute window, and writing a 1–3
 * sentence note about what happens there. No gaps, no skipping.
 *
 * Used in /api/youtube-summary (short-video call + map/section/reduce) and
 * /api/youtube-interview, so EVERY output ends with a complete timeline the
 * user can scan end-to-end.
 */
export const TIMELINE_RULES =
  `\n\nMINUTE-BY-MINUTE TIMELINE (mandatory section — never skip):\n` +
  `You MUST end every output with a section titled exactly:\n` +
  `   ## ⏱️ Minute-by-Minute Timeline\n\n` +
  `Rules for this section:\n` +
  `- Walk through the ENTIRE video from start to end. Do NOT skip any part.\n` +
  `- Pick ONE representative timestamp for every ~1–5 minute window of the video. ` +
  `For a 30-minute video that means ~6–30 entries; for a 2-hour video, ~24–120 entries. ` +
  `It is better to have MORE entries than fewer — never leave a 5-minute gap with no entry.\n` +
  `- Each entry MUST be a Markdown bullet in this exact format:\n` +
  `    - [MM:SS] short title — 1–3 sentence description of what happens at this moment. ` +
  `Copy the timestamp EXACTLY from the transcript (use [H:MM:SS] if the video is 1 hour+).\n` +
  `- The timestamps MUST be in ascending order with no duplicates.\n` +
  `- Cover EVERY topic, demo, example, definition, transition, and notable moment — ` +
  `the user should be able to scan this list and find ANY part of the video.\n` +
  `- Do NOT invent timestamps. If you are unsure, find the closest real timestamp ` +
  `in the transcript and use that.\n` +
  `- After the bullets, add a one-line summary: "Total covered: [start]–[end], N moments."\n\n` +
  `Example of the expected format:\n` +
  `   ## ⏱️ Minute-by-Minute Timeline\n` +
  `   - [0:42] Channel intro — host introduces the topic and today's agenda.\n` +
  `   - [3:15] First concept — definition of X with a quick analogy.\n` +
  `   - [7:50] Code demo — walks through a minimal example in the editor.\n` +
  `   - [12:08] Common pitfall — explains why naive approach fails.\n` +
  `   ...\n` +
  `   Total covered: [0:00]–[28:45], 18 moments.\n`;

/**
 * Build the LANGUAGE INSTRUCTION block that gets appended to YouTube-related
 * system prompts.
 *
 * Behavior:
 *   - If `language` is empty/undefined → returns an empty string. The LLM
 *     uses its default (English) — preserves the original "out of the box"
 *     behavior when the user doesn't pick a language.
 *   - If `language` is set (e.g. "Hindi", "Spanish", "Japanese", "français")
 *     → returns a strict instruction telling the LLM to write the entire
 *     response in that language, while keeping timestamps, code, and
 *     technical terms in their original form.
 *
 * This is shared across /api/youtube-summary, /api/youtube-interview,
 * /api/youtube-load, and /api/chat (ask-about-video mode) so the user's
 * language preference is honored everywhere consistently.
 */
export function buildLanguageInstruction(language?: string): string {
  const trimmed = (language ?? "").trim();
  if (!trimmed) return "";
  return (
    `\n\nLANGUAGE INSTRUCTION (very important):\n` +
    `- Write the ENTIRE response in ${trimmed}. This includes the TL;DR, every section heading, ` +
    `every explanation, every quote/insight, the chapter index, and any tips or notes.\n` +
    `- Keep timestamps (e.g. [3:25], [1:25:30]), code snippets, file paths, URLs, library/framework ` +
    `names, and command-line tools in their ORIGINAL form — do NOT translate them.\n` +
    `- If the transcript is in a different language, still answer in ${trimmed}. Translate ` +
    `quoted speech when needed, but keep the timestamp markers intact.\n` +
    `- Use natural, fluent ${trimmed} appropriate for a technical audience. Avoid awkward ` +
    `literal translations of idioms or domain terms that have well-known ${trimmed} equivalents.`
  );
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
 * Fetch lightweight video metadata (title, author, thumbnail).
 *
 * Strategy A: If YOUTUBE_API_KEY is set in the environment, use the official
 *             YouTube Data API v3 (most reliable — no bot protection).
 * Strategy B: Fall back to YouTube's public oEmbed endpoint (no key needed,
 *             but can fail on bot-protected / age-restricted videos).
 *
 * Results are cached for META_CACHE_TTL_MS to avoid redundant fetches.
 */
export async function fetchVideoMeta(
  videoId: string
): Promise<VideoMeta | null> {
  const cached = metaCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached;
  }

  // Strategy A: Official YouTube Data API v3 (most reliable — no bot protection).
  // Only used if YOUTUBE_API_KEY is set in the environment.
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey && apiKey.trim() !== "") {
    try {
      const url =
        `https://www.googleapis.com/youtube/v3/videos` +
        `?part=snippet&id=${videoId}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          items?: Array<{
            snippet?: {
              title?: string;
              channelTitle?: string;
              thumbnails?: {
                high?: { url?: string };
                medium?: { url?: string };
                default?: { url?: string };
              };
            };
          }>;
        };
        const item = json.items?.[0];
        if (item?.snippet?.title) {
          const entry: MetaCacheEntry = {
            title: item.snippet.title,
            author: item.snippet.channelTitle || "Unknown",
            thumbnailUrl:
              item.snippet.thumbnails?.high?.url ||
              item.snippet.thumbnails?.medium?.url ||
              item.snippet.thumbnails?.default?.url ||
              `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            fetchedAt: Date.now(),
          };
          metaCache.set(videoId, entry);
          return entry;
        }
      }
    } catch {
      // Fall through to oEmbed strategy below.
    }
  }

  // Strategy B: Public oEmbed endpoint (no API key needed, but can fail on
  // bot-protected / age-restricted videos).
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
// Uses clientVersion 20.10.38 — the most permissive YouTube ANDROID client
// version we've tested. Newer versions (19.29.37, 19.x, 20.x with osName)
// get rejected with HTTP 400; older versions work but get "Sign in to confirm
// you're not a bot" more often. 20.10.38 is the sweet spot.
//
// The ANDROID client bypasses YouTube's JS challenge / consent page since
// the mobile API doesn't go through the web player at all.
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

// Strategy 2: scrape the watch page HTML (with warmed cookies + browser headers)
async function fetchCaptionTracksViaWatchPage(
  videoId: string
): Promise<CaptionTrack[] | null> {
  const cookieHeader = await warmCookies();
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
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
  const cookieHeader = await warmCookies();

  const captionRes = await fetch(trackUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
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

  // Returns true if the error message looks like YouTube bot-protection /
  // rate-limiting. Used both to flag the final error as BOT_BLOCKED and to
  // decide whether to use a longer backoff before the next strategy.
  function isBotBlockMessage(msg: string): boolean {
    return /sign in|bot|consent|429|rate.?limit|captcha|too many requests|unusual traffic/i.test(
      msg
    );
  }

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
      const blocked = isBotBlockMessage(msg);
      if (blocked) {
        botBlockedSeen = true;
        lastError = e as Error;
      } else if (!botBlockedSeen) {
        lastError = e as Error;
      }
      // 429 = rate limit: give YouTube time to cool down before next attempt.
      // Bot-block / "Sign in" usually clears with a 1.5s pause. Other errors
      // (e.g. caption format unsupported) don't need any delay.
      const backoff = blocked ? 1500 : 400;
      await new Promise((r) => setTimeout(r, backoff));
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
        const blocked = isBotBlockMessage(msg);
        if (blocked) {
          botBlockedSeen = true;
          lastError = e as Error;
        } else if (!botBlockedSeen) {
          lastError = e as Error;
        }
        const backoff = blocked ? 1500 : 400;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  if (!segments || segments.length === 0) {
    if (botBlockedSeen) {
      // Note: the manual-paste fallback was removed from the UI. This message
      // is surfaced to the user as a graceful "try again later" — no broken
      // instructions, no dead-end UI references. The page.tsx handler replaces
      // this text with its own friendlier copy before showing the user.
      const friendlyMessage =
        "YouTube is rate-limiting this server's IP and asking us to sign in to " +
        "confirm we're not a bot. This is temporary and usually clears within a " +
        "few minutes. Please try again, or try a different video.";
      const err = new Error(friendlyMessage) as BotBlockedError;
      err.code = "BOT_BLOCKED";
      throw err;
    }
    const msg = lastError?.message || "";
    throw new Error(
      "This video has no captions or transcript available, or YouTube blocked the request. " +
        "Try a different video with English captions enabled, or try again in a few minutes." +
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
