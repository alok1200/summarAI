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
import {
  chatComplete,
  chatCompleteStream,
  streamHeaderAndLLM,
  type ChatMessage,
} from "@/lib/llm";
import {
  chunkTranscript,
  mapChunks,
  shouldUseMapReduce,
  type TranscriptChunk,
} from "@/lib/youtube-chunks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * MAP step: summarize a single chunk. Used for parallel processing of long
 * transcripts. Each chunk gets its own focused summary that preserves the
 * timestamps from that segment of the video.
 */
async function summarizeChunk(
  chunk: TranscriptChunk,
  ctx: { url: string; videoTitle: string | undefined; videoChannel: string | undefined; instructions: string | undefined }
): Promise<string> {
  const systemPrompt =
    `You are a helpful AI assistant that summarizes ONE segment of a longer YouTube video transcript. ` +
    `This segment covers ${chunk.startTimeLabel} – ${chunk.endTimeLabel} ` +
    `(chunk ${chunk.index} of ${chunk.total}). ` +
    `Produce a focused, well-structured summary of JUST this segment with:\n` +
    `- A 2-3 sentence overview of what's discussed in this segment\n` +
    `- A bulleted list of the key points (each with a [MM:SS] timestamp from within this segment)\n` +
    `- Any notable quotes or insights\n\n` +
    `Use Markdown. Do not invent information that isn't in the transcript. ` +
    `Keep it concise — under 400 words.`;

  const userMessage =
    `Summarize this segment of a YouTube video transcript.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Segment: ${chunk.startTimeLabel} – ${chunk.endTimeLabel} (chunk ${chunk.index}/${chunk.total}, ${chunk.segmentCount} segments)\n\n` +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `Transcript segment:\n\n${chunk.text}\n\n` +
    `Provide your structured summary now.`;

  return await chatComplete([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
}

/**
 * REDUCE step: combine per-chunk summaries into one unified summary.
 * Streams the final result so the user sees tokens immediately.
 */
function buildReduceMessages(
  chunkSummaries: string[],
  chunks: TranscriptChunk[],
  ctx: {
    url: string;
    videoTitle: string | undefined;
    videoChannel: string | undefined;
    instructions: string | undefined;
    actualStartTime: number;
    actualEndTime: number;
    totalSegments: number;
  }
): ChatMessage[] {
  const systemPrompt =
    `You are a helpful AI assistant producing the FINAL summary of a long YouTube video. ` +
    `You will be given ${chunkSummaries.length} per-segment summaries (each covering a different ` +
    `time range of the video). Your job is to synthesize them into ONE coherent, well-structured ` +
    `summary that flows naturally. Do NOT just concatenate — reorganize and deduplicate so the ` +
    `reader gets a clear picture of the whole video.\n\n` +
    `Produce:\n` +
    `1. A one-paragraph overview of the entire video\n` +
    `2. A bulleted list of the most important key points (with [MM:SS] timestamps)\n` +
    `3. Notable quotes or insights\n` +
    `4. A brief "Chapter index" listing the main topics with their time ranges\n\n` +
    `Use Markdown. Reference timestamps in [MM:SS] format. ` +
    `Do not invent information not present in the per-segment summaries.`;

  const segmentsDescription = chunkSummaries
    .map((s, i) => {
      const c = chunks[i];
      return `### Segment ${c.index} of ${c.total}  (${c.startTimeLabel} – ${c.endTimeLabel})\n\n${s}`;
    })
    .join("\n\n---\n\n");

  const userMessage =
    `Produce the final unified summary of this YouTube video.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Total time range: ${formatTime(ctx.actualStartTime)} – ${formatTime(ctx.actualEndTime)}  ` +
    `(${ctx.totalSegments} segments across ${chunks.length} chunks)\n\n` +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `Per-segment summaries:\n\n${segmentsDescription}\n\n` +
    `Please provide the final unified summary now.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

export async function POST(req: NextRequest) {
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

    const videoMeta: VideoMeta | null = await fetchVideoMeta(videoId);
    const ctx = {
      url,
      videoTitle: videoMeta?.title,
      videoChannel: videoMeta?.author,
      instructions: instructions || undefined,
      actualStartTime,
      actualEndTime,
      totalSegments: filtered.length,
    };

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

    // Decide whether to use map-reduce (long videos) or a single LLM call.
    const useMapReduce = shouldUseMapReduce(filtered);

    if (!useMapReduce) {
      // ---------- Short video: single LLM call with real streaming ----------
      const transcriptText = filtered
        .map((s) => `[${formatTime(s.start)}] ${s.text}`)
        .join("\n");

      const systemPrompt =
        "You are a helpful AI assistant that summarizes YouTube video transcripts. " +
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
        )}  (about ${Math.round(actualEndTime - actualStartTime)}s, ${filtered.length} segments)\n\n` +
        (instructions
          ? `Additional instructions from the user: ${instructions}\n\n`
          : "") +
        `Transcript (with timestamps):\n\n${transcriptText}\n\n` +
        `Please provide your structured summary now.`;

      const llmStream = await chatCompleteStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);
      return streamHeaderAndLLM(header, llmStream);
    }

    // ---------- Long video: MAP-REDUCE with parallel chunk summarization ----------
    const chunks = chunkTranscript(filtered);
    console.log(
      `[youtube-summary] MAP-REDUCE: ${filtered.length} segments → ${chunks.length} chunks (parallel)`
    );

    // Build a streaming response that:
    //   1. Emits the header immediately (so the proxy doesn't time out)
    //   2. Emits a "processing" status line so the user sees progress
    //   3. Runs all chunk summaries in parallel
    //   4. Emits each chunk's summary as it completes (with a separator)
    //   5. Once all chunks are done, runs the reduce step and streams the
    //      final unified summary.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (text: string) => {
          controller.enqueue(encoder.encode(text));
        };

        // Phase 1: header + map-reduce notice
        emit(header);
        emit(
          `⏳ **Processing ${chunks.length} chunks in parallel** ` +
            `(each ~5-10 min of video, summarized independently then merged).\n\n`
        );

        // Phase 2: parallel map step
        let completed = 0;
        const chunkSummaries = await mapChunks(
          chunks,
          (chunk) => summarizeChunk(chunk, ctx),
          (done, total) => {
            completed = done;
            emit(`✅ Chunk ${done}/${total} summarized\n`);
          }
        );

        emit(`\n🔄 **Merging ${chunkSummaries.length} chunk summaries into final answer…**\n\n---\n\n`);

        // Phase 3: reduce step — stream the final unified summary
        const reduceMessages = buildReduceMessages(chunkSummaries, chunks, ctx);
        const finalStream = await chatCompleteStream(reduceMessages);
        const reader = finalStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
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
