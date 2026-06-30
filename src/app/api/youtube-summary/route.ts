import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

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
  // Maybe the user just pasted the video id
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

async function fetchTranscript(
  videoId: string
): Promise<TranscriptSegment[]> {
  // Strategy: try fetching the watch page first (richer metadata). If that
  // gets rate-limited (429) or blocked, fall back to YouTube's internal
  // `youtubei/v1/player` JSON API, which tends to be more permissive.
  let captionTracks: any[] | null = null;
  let lastError: Error | null = null;

  // ----- Attempt 1: scrape the watch page -----
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(watchUrl, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:var\s|const\s|let\s|<\/script>|$)/
      );
      if (match) {
        try {
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
            playerResponse?.captions?.playerCaptionsTracklistRenderer
              ?.captionTracks;
          if (Array.isArray(tracks) && tracks.length > 0) {
            captionTracks = tracks;
          }
        } catch (e) {
          lastError = e as Error;
        }
      }
    } else if (res.status === 429) {
      lastError = new Error(
        "YouTube rate-limited the request. Please try again in a moment."
      );
    } else {
      lastError = new Error(
        `YouTube returned HTTP ${res.status}. The video may be private, deleted, or region-locked.`
      );
    }
  } catch (e) {
    lastError = e as Error;
  }

  // ----- Attempt 2: use the youtubei player API -----
  if (!captionTracks) {
    try {
      const tracks = await fetchCaptionTracksViaPlayerApi(videoId);
      if (tracks && tracks.length > 0) {
        captionTracks = tracks;
      }
    } catch (e) {
      lastError = e as Error;
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error(
      lastError?.message ||
        "This video has no captions or transcript available, or YouTube blocked the request. Try a different video."
    );
  }

  // Prefer English (manual), then English (auto), then first available
  const enManual = captionTracks.find(
    (t: any) => t.languageCode === "en" && t.kind !== "asr"
  );
  const enAuto = captionTracks.find(
    (t: any) => t.languageCode === "en" && t.kind === "asr"
  );
  const track = enManual || enAuto || captionTracks[0];
  let trackUrl: string = track.baseUrl;

  // Force JSON3 for reliable parsing
  if (trackUrl.includes("fmt=")) {
    trackUrl = trackUrl.replace(/fmt=[^&]+/, "fmt=json3");
  } else {
    trackUrl += (trackUrl.includes("?") ? "&" : "?") + "fmt=json3";
  }

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
      const json = JSON.parse(captionText);
      if (Array.isArray(json.events)) {
        segments = json.events
          .filter(
            (e: any) =>
              e.segs && Array.isArray(e.segs) && e.segs.length > 0
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
    } catch {
      // fall through to XML
    }
  }

  // Fallback to XML
  if (segments.length === 0) {
    const xmlRegex =
      /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m: RegExpExecArray | null;
    while ((m = xmlRegex.exec(captionText)) !== null) {
      const start = parseFloat(m[1]);
      const dur = parseFloat(m[2]);
      const text = decodeEntities(m[3])
        .replace(/<[^>]+>/g, "")
        .replace(/\n/g, " ")
        .trim();
      if (text) segments.push({ start, dur, text });
    }
  }

  if (segments.length === 0) {
    throw new Error(
      "Could not parse the transcript. The caption format may be unsupported."
    );
  }
  return segments;
}

/**
 * YouTube's internal `youtubei/v1/player` API. Returns caption tracks without
 * needing to scrape HTML. Uses the public ANDROID client identity which is
 * generally less aggressively rate-limited.
 */
async function fetchCaptionTracksViaPlayerApi(
  videoId: string
): Promise<any[] | null> {
  const endpoint =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
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
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`YouTube player API returned HTTP ${res.status}`);
  }
  const json = await res.json();
  const playability = json?.playabilityStatus;
  if (
    playability?.status !== "OK" &&
    playability?.status !== "LIVE_STREAM_OFFLINE"
  ) {
    throw new Error(
      playability?.reason ||
        playability?.messages?.[0] ||
        "This video cannot be accessed."
    );
  }
  const tracks =
    json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : null;
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

    const allSegments = await fetchTranscript(videoId);

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

    // Stream the response with a metadata header prepended
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
        // Send the header first
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
