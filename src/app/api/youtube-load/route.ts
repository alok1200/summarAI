import { NextRequest } from "next/server";
import {
  type TranscriptSegment,
  extractVideoId,
  parseTimeString,
  formatTime,
  fetchVideoMeta,
  fetchTranscriptWithRetry,
  parseUserTranscript,
} from "@/lib/youtube-transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoadRequestBody {
  url: string;
  startTime?: string;
  endTime?: string;
  /** Optional: user-pasted transcript (bypasses auto-fetch) */
  transcript?: string;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Loads a YouTube video's transcript (auto-fetch with multi-strategy fallback,
 * or accepts a user-pasted transcript) and returns it as JSON along with the
 * video's metadata. Used by the "Ask about video" mode in the chat UI to
 * pre-load the transcript into the conversation context before the user starts
 * asking questions.
 */
export async function POST(req: NextRequest) {
  let parsedVideoId: string | null = null;
  try {
    const body = (await req.json()) as LoadRequestBody;
    const url: string = body.url ?? "";
    const startTimeStr: string = body.startTime ?? "";
    const endTimeStr: string = body.endTime ?? "";
    const manualTranscript: string = (body.transcript ?? "").trim();

    parsedVideoId = extractVideoId(url);
    if (!parsedVideoId) {
      return jsonResponse(400, {
        error:
          "Could not extract a video ID from this URL. Please paste a YouTube link like https://www.youtube.com/watch?v=…",
      });
    }
    const videoId = parsedVideoId;

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
    let skipTimeFilter = false;

    if (manualTranscript) {
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
        skipTimeFilter = true;
      }
    } else {
      allSegments = await fetchTranscriptWithRetry(videoId);
    }

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
        "Time range was ignored because the pasted transcript has no timestamps — used the whole paste instead.";
    } else if (filtered.length === 0 && allSegments.length > 0) {
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
        `(${formatTime(firstStart)} – ${formatTime(lastStart)}, ${totalSegs} segments) was used instead.`;
    }

    const actualStartTime = filtered[0].start;
    const lastSeg = filtered[filtered.length - 1];
    const actualEndTime = lastSeg.start + lastSeg.dur;

    // Build the transcript text that will be injected into the chat system
    // prompt. Cap at 80k chars to stay within model context limits.
    const transcriptText = filtered
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join("\n");

    const MAX_CHARS = 80000;
    const truncated =
      transcriptText.length > MAX_CHARS
        ? transcriptText.slice(0, MAX_CHARS) +
          "\n\n[... transcript truncated due to length ...]"
        : transcriptText;

    const videoMeta = await fetchVideoMeta(videoId);

    return jsonResponse(200, {
      ok: true,
      videoId,
      url,
      title: videoMeta?.title ?? "Unknown title",
      author: videoMeta?.author ?? "Unknown channel",
      thumbnailUrl: videoMeta?.thumbnailUrl,
      isManual,
      startTime: actualStartTime,
      endTime: actualEndTime,
      segmentCount: filtered.length,
      rangeNote,
      transcript: truncated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = (err as any)?.code;
    console.error("[youtube-load] error:", message, "code:", code);

    let metaPayload: {
      title?: string;
      author?: string;
      thumbnailUrl?: string;
    } | null = null;
    if (parsedVideoId) {
      try {
        const m = await fetchVideoMeta(parsedVideoId);
        if (m) {
          metaPayload = {
            title: m.title,
            author: m.author,
            thumbnailUrl: m.thumbnailUrl,
          };
        }
      } catch {
        // ignore
      }
    }

    if (code === "BOT_BLOCKED") {
      return jsonResponse(403, {
        error: message,
        code: "BOT_BLOCKED",
        videoMeta: metaPayload,
      });
    }
    return jsonResponse(500, {
      error: message || "Failed to load video transcript.",
      videoMeta: metaPayload,
    });
  }
}
