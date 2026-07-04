import { NextRequest } from "next/server";
import {
  type TranscriptSegment,
  type VideoMeta,
  extractVideoId,
  parseTimeString,
  formatTime,
  fetchVideoMeta,
  fetchTranscriptWithRetry,
  parseUserTranscript,
} from "@/lib/youtube-transcript";
import { chatCompleteStream, streamHeaderAndLLM } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  // Extract videoId up here so the catch block can use it for fetching video
  // metadata even after the body has been consumed.
  let parsedVideoId: string | null = null;
  try {
    const body = await req.json();
    const url: string = body.url ?? "";
    const startTimeStr: string = body.startTime ?? "";
    const endTimeStr: string = body.endTime ?? "";
    const instructions: string = (body.instructions ?? "").trim();
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
        "Time range was ignored because the pasted transcript has no timestamps — summarized the whole paste instead.";
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
        `(${formatTime(firstStart)} – ${formatTime(lastStart)}, ${totalSegs} segments) was summarized instead. ` +
        `Adjust the time range to overlap with the transcript and try again for a more targeted summary.`;
    }

    const actualStartTime = filtered[0].start;
    const lastSeg = filtered[filtered.length - 1];
    const actualEndTime = lastSeg.start + lastSeg.dur;

    const transcriptText = filtered
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join("\n");

    const MAX_CHARS = 80000;
    const truncated =
      transcriptText.length > MAX_CHARS
        ? transcriptText.slice(0, MAX_CHARS) +
          "\n\n[... transcript truncated due to length ...]"
        : transcriptText;

    const videoMeta: VideoMeta | null = await fetchVideoMeta(videoId);

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
      (videoMeta
        ? `Video title: ${videoMeta.title}\nVideo channel: ${videoMeta.author}\n`
        : "") +
      `Selected time range: ${formatTime(actualStartTime)} – ${formatTime(
        actualEndTime
      )}  (about ${Math.round(durationSec)}s, ${filtered.length} segments)\n\n` +
      (instructions
        ? `Additional instructions from the user: ${instructions}\n\n`
        : "") +
      `Transcript (with timestamps):\n\n${truncated}\n\n` +
      `Please provide your structured summary now.`;

    // REAL STREAMING: pipe the LLM's streaming response directly so the
    // first token reaches the browser in ~1 second. This prevents the
    // preview proxy from returning 502 on long generations.
    const llmStream = await chatCompleteStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

    const sourceLabel = isManual ? " (manual paste)" : "";
    const header =
      `**▶️ YouTube Video Summary${sourceLabel}**\n\n` +
      (videoMeta
        ? `**Title:** ${videoMeta.title}\n**Channel:** ${videoMeta.author}\n`
        : "") +
      `**URL:** ${url}\n` +
      `**Time range:** ${formatTime(actualStartTime)} – ${formatTime(
        actualEndTime
      )}  ·  ${filtered.length} transcript segments\n` +
      (rangeNote ? `**Note:** ${rangeNote}\n` : "") +
      (instructions ? `**Your instructions:** ${instructions}\n` : "") +
      `\n---\n\n`;

    return streamHeaderAndLLM(header, llmStream);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = (err as any)?.code;
    console.error("[youtube-summary] error:", message, "code:", code);

    let videoMeta: VideoMeta | null = null;
    if (parsedVideoId) {
      try {
        videoMeta = await fetchVideoMeta(parsedVideoId);
      } catch {
        // ignore
      }
    }

    const metaPayload = videoMeta
      ? {
          title: videoMeta.title,
          author: videoMeta.author,
          thumbnailUrl: videoMeta.thumbnailUrl,
        }
      : null;

    if (code === "BOT_BLOCKED") {
      return jsonResponse(403, {
        error: message,
        code: "BOT_BLOCKED",
        videoMeta: metaPayload,
      });
    }
    const friendlyMsg = /502|503|504|bad gateway|service unavailable|gateway timeout|upstream/i.test(
      message
    )
      ? "The AI service is temporarily unavailable (gateway error). Please try again in a few seconds — your request will be retried automatically on the next attempt."
      : message || "YouTube summary failed.";
    return jsonResponse(500, {
      error: friendlyMsg,
      videoMeta: metaPayload,
    });
  }
}
