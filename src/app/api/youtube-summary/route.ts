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
    `You are an expert AI assistant that produces COMPREHENSIVE, DETAILED summaries of ONE segment of a longer YouTube video transcript. ` +
    `This segment covers ${chunk.startTimeLabel} – ${chunk.endTimeLabel} ` +
    `(chunk ${chunk.index} of ${chunk.total}). ` +
    `Your goal is to capture EVERY topic, sub-topic, example, demo, and insight in this segment — nothing should be lost.\n\n` +
    `Produce a thorough, well-structured summary of JUST this segment with:\n` +
    `- A 3-4 sentence overview that explicitly names every topic discussed in this segment\n` +
    `- A DETAILED breakdown with a ### sub-heading for EVERY topic, sub-topic, or notable moment. Each sub-section must include:\n` +
    `  · The [MM:SS] timestamp where it appears in this segment\n` +
    `  · A long-form explanation (3-6+ sentences) of what is being discussed\n` +
    `  · Any examples, demos, code, or analogies used\n` +
    `  · Any context, motivation, reasoning, or background provided\n` +
    `  · Any caveats, tips, gotchas, or best-practice advice\n` +
    `  · Any names, tools, libraries, frameworks, or resources mentioned\n` +
    `- A "Notable quotes & insights" subsection with direct quotes (with timestamps)\n\n` +
    `Use Markdown. Do not invent information that isn't in the transcript. ` +
    `Be EXHAUSTIVE — it is better to over-include than to miss a small topic. ` +
    `Aim for 800-1500 words for a typical 5-10 minute segment.`;

  const userMessage =
    `Produce a COMPREHENSIVE summary of this segment of a YouTube video transcript. ` +
    `Cover EVERY topic in long-form detail — do not skip or compress anything.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Segment: ${chunk.startTimeLabel} – ${chunk.endTimeLabel} (chunk ${chunk.index}/${chunk.total}, ${chunk.segmentCount} segments)\n\n` +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `Transcript segment:\n\n${chunk.text}\n\n` +
    `Provide your comprehensive structured summary now.`;

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
    `You are an expert AI assistant producing the FINAL COMPREHENSIVE summary of a long YouTube video. ` +
    `You will be given ${chunkSummaries.length} per-segment summaries (each covering a different ` +
    `time range of the video, in order). Your job is to synthesize them into ONE coherent, EXHAUSTIVE ` +
    `summary that captures EVERY topic, sub-topic, example, demo, and insight from the entire video. ` +
    `Reorganize and deduplicate where the same topic appears in multiple segments, but DO NOT drop any ` +
    `content — exhaustiveness is the top priority.\n\n` +
    `Your output MUST follow this exact structure (use Markdown):\n\n` +
    `## TL;DR — All Key Points at a Glance\n` +
    `A 5-8 sentence overview that explicitly names EVERY major topic, concept, technique, tool, and idea discussed ` +
    `across the entire video. The reader should get a complete map of the video's coverage just from this section. ` +
    `Do not be abstract — list concrete subject names.\n\n` +
    `## Detailed Breakdown — Every Point Explained\n` +
    `For EVERY topic, sub-topic, example, demo, or notable moment in the entire video, create a ### sub-heading ` +
    `and write a LONG-FORM detailed explanation underneath. Group related content from different segments together ` +
    `under the most fitting heading. Each sub-section MUST include:\n` +
    `- The [MM:SS] timestamp(s) where it appears in the video\n` +
    `- A thorough explanation of WHAT is being discussed (3-6+ sentences minimum)\n` +
    `- Any examples, demos, code snippets, or analogies the speaker uses\n` +
    `- Any context, reasoning, motivation, or background the speaker provides\n` +
    `- Any caveats, tips, gotchas, or best-practice advice mentioned\n` +
    `- Any names, tools, libraries, frameworks, URLs, or resources referenced\n\n` +
    `Cover EVERY small topic — even brief mentions or quick tips deserve their own entry. ` +
    `For a long video, aim for 30-100+ distinct sub-sections. It is far better to over-include than to miss something.\n\n` +
    `## Notable Quotes & Insights\n` +
    `Direct quotes (with timestamps) and any particularly insightful or counterintuitive points the speaker makes ` +
    `anywhere in the video.\n\n` +
    `## Chapter Index\n` +
    `A compact list of the main sections of the video with their time ranges, so the reader can jump to a specific part.\n\n` +
    `STRICT RULES:\n` +
    `- Do NOT invent information not present in the per-segment summaries.\n` +
    `- Do NOT be concise at the cost of completeness — exhaustiveness is the priority.\n` +
    `- Always reference timestamps in [MM:SS] format.\n` +
    `- When the same topic appears in multiple segments, MERGE the details under one heading (don't repeat).\n` +
    `- Use Markdown headings, bold, lists, and code blocks for clarity.`;

  const segmentsDescription = chunkSummaries
    .map((s, i) => {
      const c = chunks[i];
      return `### Segment ${c.index} of ${c.total}  (${c.startTimeLabel} – ${c.endTimeLabel})\n\n${s}`;
    })
    .join("\n\n---\n\n");

  const userMessage =
    `Produce the FINAL COMPREHENSIVE unified summary of this YouTube video. ` +
    `Cover EVERY topic from EVERY segment in long-form detail — do not skip, compress, or omit anything.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Total time range: ${formatTime(ctx.actualStartTime)} – ${formatTime(ctx.actualEndTime)}  ` +
    `(${ctx.totalSegments} segments across ${chunks.length} chunks)\n\n` +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `Per-segment summaries:\n\n${segmentsDescription}\n\n` +
    `Please provide the final comprehensive unified summary now. Remember: brief TL;DR covering ALL points, ` +
    `then DETAILED long-form coverage of EVERY single topic across all segments.`;

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
        "You are an expert AI assistant that produces COMPREHENSIVE, EXHAUSTIVE summaries of YouTube video transcripts. " +
        "Your goal is to cover EVERY topic, sub-topic, example, demo, and insight mentioned in the video — nothing should be left out.\n\n" +
        "Your output MUST follow this exact structure (use Markdown):\n\n" +
        "## TL;DR — All Key Points at a Glance\n" +
        "A 4-6 sentence overview that names EVERY major topic discussed in the video. " +
        "Don't summarize abstractly — explicitly list every subject, technique, concept, tool, or idea mentioned, " +
        "so the reader gets a complete map of what the video covers just from this section.\n\n" +
        "## Detailed Breakdown — Every Point Explained\n" +
        "For EVERY topic, sub-topic, example, or notable moment in the video, create a ### sub-heading and write a LONG-FORM " +
        "detailed explanation underneath. Each sub-section MUST include:\n" +
        "- The [MM:SS] timestamp where it appears in the video\n" +
        "- A thorough explanation of WHAT is being discussed (not just a one-liner — write 3-6 sentences minimum per point)\n" +
        "- Any examples, demos, code snippets, or analogies the speaker uses\n" +
        "- Any context, reasoning, motivation, or background the speaker provides\n" +
        "- Any caveats, tips, gotchas, or best-practice advice mentioned\n" +
        "- Any names, tools, libraries, frameworks, URLs, or resources referenced\n\n" +
        "Cover EVERY small topic — even minor asides, brief mentions, or quick tips deserve their own entry. " +
        "It is better to over-include than to miss something. Aim for 15-40 distinct sub-sections for a typical 10-30 minute video.\n\n" +
        "## Notable Quotes & Insights\n" +
        "Direct quotes (with timestamps) and any particularly insightful or counterintuitive points the speaker makes.\n\n" +
        "## Chapter Index\n" +
        "A compact list of the main sections of the video with their time ranges, so the reader can jump to a specific part.\n\n" +
        "STRICT RULES:\n" +
        "- Do NOT invent information that isn't in the transcript.\n" +
        "- Do NOT be concise at the cost of completeness — exhaustiveness is the priority.\n" +
        "- Always reference timestamps in [MM:SS] format so the user can find the source.\n" +
        "- Use Markdown headings, bold, lists, and code blocks for clarity.";

      const userMessage =
        `Please produce a COMPREHENSIVE summary of the following YouTube video transcript. ` +
        `Cover EVERY topic and sub-topic in long-form detail — do not skip or compress anything.\n\n` +
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
        `Provide your comprehensive structured summary now. Remember: brief TL;DR covering ALL points, then DETAILED long-form coverage of EVERY single topic.`;

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
