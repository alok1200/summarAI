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
  TIMESTAMP_RULES,
  TIMELINE_RULES,
  buildLanguageInstruction,
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
  planReduce,
  groupLabel,
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
  ctx: { url: string; videoTitle: string | undefined; videoChannel: string | undefined; instructions: string | undefined; language?: string }
): Promise<string> {
  const systemPrompt =
    `You are an expert AI assistant that produces COMPREHENSIVE, DETAILED summaries of ONE segment of a longer YouTube video transcript. ` +
    `This segment covers ${chunk.startTimeLabel} – ${chunk.endTimeLabel} ` +
    `(chunk ${chunk.index} of ${chunk.total}). ` +
    `Your goal is to capture EVERY topic, sub-topic, example, demo, and insight in this segment — nothing should be lost.\n\n` +
    `Produce a thorough, well-structured summary of JUST this segment with:\n` +
    `- A 3-4 sentence overview that explicitly names every topic discussed in this segment\n` +
    `- A DETAILED breakdown with a ### sub-heading for EVERY topic, sub-topic, or notable moment. Each sub-section must include:\n` +
    `  · The timestamp where it appears in this segment — copy it EXACTLY from the transcript (e.g. [3:25] or [1:25:30])\n` +
    `  · A long-form explanation (3-6+ sentences) of what is being discussed\n` +
    `  · Any examples, demos, code, or analogies used\n` +
    `  · Any context, motivation, reasoning, or background provided\n` +
    `  · Any caveats, tips, gotchas, or best-practice advice\n` +
    `  · Any names, tools, libraries, frameworks, or resources mentioned\n` +
    `- A "Notable quotes & insights" subsection with direct quotes (each followed by its [timestamp])\n\n` +
    TIMESTAMP_RULES + `\n\n` +
    `Use Markdown. Do not invent information that isn't in the transcript. ` +
    `Be EXHAUSTIVE — it is better to over-include than to miss a small topic. ` +
    `Aim for 800-1500 words for a typical 5-10 minute segment.` +
    TIMELINE_RULES +
    buildLanguageInstruction(ctx.language);

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

  return await chatComplete(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 8000 }
  );
}

/**
 * SECTION REDUCE step (level 1 of hierarchical reduce): combine the per-chunk
 * summaries from ONE batch of ~7 contiguous chunks into a single
 * "section summary" for that time range. This keeps the final reduce call's
 * input small enough to fit in the LLM's context window even for 50-hour videos.
 *
 * Like the MAP step, this produces a comprehensive long-form summary — just
 * synthesized across multiple chunks of the same section.
 */
async function summarizeSection(
  group: TranscriptChunk[],
  chunkSummariesForGroup: string[],
  ctx: { url: string; videoTitle: string | undefined; videoChannel: string | undefined; instructions: string | undefined; language?: string }
): Promise<string> {
  const label = groupLabel(group);
  const segmentCount = group.reduce((n, c) => n + c.segmentCount, 0);

  const systemPrompt =
    `You are an expert AI assistant producing a COMPREHENSIVE section summary of part of a long YouTube video. ` +
    `This section covers ${label} (${segmentCount} transcript segments total). ` +
    `You will be given ${chunkSummariesForGroup.length} per-chunk summaries for contiguous chunks within this section. ` +
    `Synthesize them into ONE coherent, EXHAUSTIVE summary that captures EVERY topic, sub-topic, example, demo, and insight ` +
    `from this section. Reorganize and deduplicate where the same topic appears in multiple chunks, but DO NOT drop any content.\n\n` +
    `Your output MUST follow this structure (use Markdown):\n\n` +
    `### Section Overview — ${label}\n` +
    `3-4 sentences naming every major topic discussed in this section.\n\n` +
    `### Detailed Breakdown — Every Point in This Section\n` +
    `For EVERY topic, sub-topic, example, or notable moment in this section, create a #### sub-heading and write a ` +
    `LONG-FORM detailed explanation (3-6+ sentences) underneath. Each sub-section must include:\n` +
    `- The timestamp(s) where it appears — copy EXACTLY from the per-chunk summaries (e.g. [3:25] or [1:25:30])\n` +
    `- A thorough explanation of what is being discussed\n` +
    `- Any examples, demos, code, analogies, context, motivation, caveats, tips, or resources mentioned\n\n` +
    `Cover EVERY small topic — even brief mentions deserve their own entry. ` +
    `Aim for 1500-3000 words for the section. Be exhaustive.\n\n` +
    TIMESTAMP_RULES + `\n\n` +
    `Use Markdown. Do not invent information not present in the per-chunk summaries.` +
    TIMELINE_RULES +
    buildLanguageInstruction(ctx.language);

  const chunksDescription = chunkSummariesForGroup
    .map((s, i) => {
      const c = group[i];
      return `#### Chunk ${c.index}/${c.total}  (${c.startTimeLabel} – ${c.endTimeLabel})\n\n${s}`;
    })
    .join("\n\n---\n\n");

  const userMessage =
    `Produce a COMPREHENSIVE section summary covering ${label}.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `Per-chunk summaries for this section:\n\n${chunksDescription}\n\n` +
    `Provide your comprehensive section summary now.`;

  return await chatComplete(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 10000 }
  );
}

/**
 * REDUCE step: combine per-chunk summaries (or per-section summaries in
 * hierarchical mode) into one unified final summary. Streams the final result
 * so the user sees tokens immediately.
 *
 * @param inputSummaries  The summaries to reduce. Each one is a long-form
 *                        markdown summary of a chunk OR a section.
 * @param inputLabels     Labels for each summary, e.g. "Segment 3 of 25 (00:15:00 – 00:22:30)"
 *                        or "Section 2 of 15 (01:42:30 – 02:55:00, chunks 8–14)".
 */
function buildReduceMessages(
  inputSummaries: string[],
  inputLabels: string[],
  ctx: {
    url: string;
    videoTitle: string | undefined;
    videoChannel: string | undefined;
    instructions: string | undefined;
    language?: string;
    actualStartTime: number;
    actualEndTime: number;
    totalSegments: number;
    /** Total chunks in the source transcript (for display). */
    totalChunks: number;
    /** Whether the inputs are section summaries (hierarchical) or chunk summaries (flat). */
    inputKind: "chunk" | "section";
  }
): ChatMessage[] {
  const inputWord = ctx.inputKind === "section" ? "section" : "per-segment";
  const systemPrompt =
    `You are an expert AI assistant producing the FINAL COMPREHENSIVE summary of a long YouTube video. ` +
    `You will be given ${inputSummaries.length} ${inputWord} summaries (each covering a different ` +
    `time range of the video, in order). Your job is to synthesize them into ONE coherent, EXHAUSTIVE ` +
    `summary that captures EVERY topic, sub-topic, example, demo, and insight from the entire video. ` +
    `Reorganize and deduplicate where the same topic appears in multiple ${inputWord}s, but DO NOT drop any ` +
    `content — exhaustiveness is the top priority.\n\n` +
    `Your output MUST follow this exact structure (use Markdown):\n\n` +
    `## TL;DR — All Key Points at a Glance\n` +
    `A 5-8 sentence overview that explicitly names EVERY major topic, concept, technique, tool, and idea discussed ` +
    `across the entire video. The reader should get a complete map of the video's coverage just from this section. ` +
    `Do not be abstract — list concrete subject names.\n\n` +
    `## Detailed Breakdown — Every Point Explained\n` +
    `For EVERY topic, sub-topic, example, demo, or notable moment in the entire video, create a ### sub-heading ` +
    `and write a LONG-FORM detailed explanation underneath. Group related content from different ${inputWord}s together ` +
    `under the most fitting heading. Each sub-section MUST include:\n` +
    `- The timestamp(s) where it appears in the video — copy EXACTLY from the ${inputWord} summaries (e.g. [3:25] or [1:25:30])\n` +
    `- A thorough explanation of WHAT is being discussed (3-6+ sentences minimum)\n` +
    `- Any examples, demos, code snippets, or analogies the speaker uses\n` +
    `- Any context, reasoning, motivation, or background the speaker provides\n` +
    `- Any caveats, tips, gotchas, or best-practice advice mentioned\n` +
    `- Any names, tools, libraries, frameworks, URLs, or resources referenced\n\n` +
    `Cover EVERY small topic — even brief mentions or quick tips deserve their own entry. ` +
    `For a long video, aim for 30-200+ distinct sub-sections. It is far better to over-include than to miss something.\n\n` +
    `## Notable Quotes & Insights\n` +
    `Direct quotes (each followed by its [timestamp]) and any particularly insightful or counterintuitive points the speaker makes ` +
    `anywhere in the video.\n\n` +
    `## Chapter Index\n` +
    `A compact list of the main sections of the video with their time ranges (using [start]–[end] format), so the reader can jump to a specific part.\n\n` +
    TIMESTAMP_RULES + `\n\n` +
    `STRICT RULES:\n` +
    `- Do NOT invent information not present in the ${inputWord} summaries.\n` +
    `- Do NOT be concise at the cost of completeness — exhaustiveness is the priority.\n` +
    `- When the same topic appears in multiple ${inputWord}s, MERGE the details under one heading (don't repeat).\n` +
    `- Use Markdown headings, bold, lists, and code blocks for clarity.` +
    TIMELINE_RULES +
    buildLanguageInstruction(ctx.language);

  const segmentsDescription = inputSummaries
    .map((s, i) => `### ${inputLabels[i]}\n\n${s}`)
    .join("\n\n---\n\n");

  const userMessage =
    `Produce the FINAL COMPREHENSIVE unified summary of this YouTube video. ` +
    `Cover EVERY topic from EVERY ${inputWord} in long-form detail — do not skip, compress, or omit anything.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Total time range: ${formatTime(ctx.actualStartTime)} – ${formatTime(ctx.actualEndTime)}  ` +
    `(${ctx.totalSegments} segments across ${ctx.totalChunks} chunks, ` +
    `synthesized from ${inputSummaries.length} ${inputWord} summaries)\n\n` +
    (ctx.instructions ? `User instructions: ${ctx.instructions}\n\n` : "") +
    `${inputWord.charAt(0).toUpperCase() + inputWord.slice(1)} summaries:\n\n${segmentsDescription}\n\n` +
    `Please provide the final comprehensive unified summary now. Remember: brief TL;DR covering ALL points, ` +
    `then DETAILED long-form coverage of EVERY single topic across all ${inputWord}s.`;

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
    const language: string = (body.language ?? "").trim();

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
      language: language || undefined,
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
      (language ? `**Response language:** ${language}\n` : "") +
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
        "- The timestamp where it appears in the video — copy it EXACTLY from the transcript (e.g. [3:25] or [1:25:30])\n" +
        "- A thorough explanation of WHAT is being discussed (not just a one-liner — write 3-6 sentences minimum per point)\n" +
        "- Any examples, demos, code snippets, or analogies the speaker uses\n" +
        "- Any context, reasoning, motivation, or background the speaker provides\n" +
        "- Any caveats, tips, gotchas, or best-practice advice mentioned\n" +
        "- Any names, tools, libraries, frameworks, URLs, or resources referenced\n\n" +
        "Cover EVERY small topic — even minor asides, brief mentions, or quick tips deserve their own entry. " +
        "It is better to over-include than to miss something. Aim for 15-40 distinct sub-sections for a typical 10-30 minute video.\n\n" +
        "## Notable Quotes & Insights\n" +
        "Direct quotes (each followed by its [timestamp]) and any particularly insightful or counterintuitive points the speaker makes.\n\n" +
        "## Chapter Index\n" +
        "A compact list of the main sections of the video with their time ranges (using [start]–[end] format), so the reader can jump to a specific part.\n\n" +
        TIMESTAMP_RULES + "\n\n" +
        "STRICT RULES:\n" +
        "- Do NOT invent information that isn't in the transcript.\n" +
        "- Do NOT be concise at the cost of completeness — exhaustiveness is the priority.\n" +
        "- Use Markdown headings, bold, lists, and code blocks for clarity." +
        TIMELINE_RULES +
        buildLanguageInstruction(language);

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

      const llmStream = await chatCompleteStream(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        { maxTokens: 16000 }
      );
      return streamHeaderAndLLM(header, llmStream);
    }

    // ---------- Long video: MAP-REDUCE with parallel chunk summarization ----------
    const chunks = chunkTranscript(filtered);
    const reducePlan = planReduce(chunks);
    console.log(
      `[youtube-summary] MAP-REDUCE: ${filtered.length} segments → ${chunks.length} chunks ` +
      `(parallel)${reducePlan.hierarchical ? ` → HIERARCHICAL reduce (${reducePlan.groups!.length} sections)` : ""}`
    );

    // Build a streaming response that:
    //   1. Emits the header immediately (so the proxy doesn't time out)
    //   2. Emits a "processing" status line so the user sees progress
    //   3. Runs all chunk summaries in parallel (MAP step)
    //   4. If chunks > 8 (hierarchical): runs per-section reduces in parallel
    //      (SECTION step), each combining ~7 chunk summaries into a section summary
    //   5. Runs the final reduce step and streams the unified summary (REDUCE step)
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
            `(each ~5-10 min of video, summarized independently then merged).` +
            (reducePlan.hierarchical
              ? `\n📊 This is a very long video — using **hierarchical reduce** ` +
                `(${reducePlan.groups!.length} sections of ~${reducePlan.groups![0].length} chunks each) ` +
                `so nothing gets truncated.`
              : "") +
            `\n\n`
        );

        // Phase 2: parallel MAP step — summarize each chunk
        const chunkSummaries = await mapChunks(
          chunks,
          (chunk) => summarizeChunk(chunk, ctx),
          (done, total) => {
            emit(`✅ Chunk ${done}/${total} summarized\n`);
          },
          // For very long videos (many chunks), bump concurrency to speed up the MAP step.
          chunks.length > 20 ? 6 : 4
        );

        // Phase 3: optional SECTION step (hierarchical reduce level 1)
        let finalSummaries: string[];
        let finalLabels: string[];
        let inputKind: "chunk" | "section";

        if (reducePlan.hierarchical) {
          const groups = reducePlan.groups!;
          emit(
            `\n🔀 **Reducing ${groups.length} sections in parallel** ` +
              `(each section merges ${groups[0].length}–${groups[groups.length - 1].length} chunk summaries)…\n`
          );

          // Build a flat list of (groupIndex, chunkSummariesForGroup) tasks,
          // then run them all in parallel with mapChunks-style concurrency.
          const sectionResults: string[] = new Array(groups.length);
          let sectionCursor = 0;
          let sectionCompleted = 0;
          const sectionConcurrency = Math.min(4, groups.length);

          async function sectionWorker() {
            while (true) {
              const idx = sectionCursor++;
              if (idx >= groups.length) return;
              const group = groups[idx];
              // chunkSummaries is indexed 0..N-1 by chunk position; group
              // contains the actual TranscriptChunk objects, so we look up
              // each chunk's summary by its 0-indexed position.
              const groupChunkIndices = group.map((c) => c.index - 1);
              const groupSummaries = groupChunkIndices.map(
                (ci) => chunkSummaries[ci] ?? ""
              );
              try {
                const s = await summarizeSection(group, groupSummaries, ctx);
                sectionResults[idx] = s;
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Unknown error";
                console.error(`[youtube-summary] section ${idx + 1} failed:`, msg);
                // Fallback: concatenate the chunk summaries for this group
                sectionResults[idx] = groupSummaries.join("\n\n---\n\n");
              }
              sectionCompleted++;
              emit(`✅ Section ${sectionCompleted}/${groups.length} reduced\n`);
            }
          }

          await Promise.all(
            Array.from({ length: sectionConcurrency }, () => sectionWorker())
          );

          finalSummaries = sectionResults;
          finalLabels = groups.map((g, i) => `Section ${i + 1} of ${groups.length}  ${groupLabel(g)}`);
          inputKind = "section";
        } else {
          finalSummaries = chunkSummaries;
          finalLabels = chunks.map(
            (c) => `Segment ${c.index} of ${c.total}  (${c.startTimeLabel} – ${c.endTimeLabel})`
          );
          inputKind = "chunk";
        }

        emit(
          `\n🔄 **Merging ${finalSummaries.length} ${inputKind} summaries into final answer…**\n\n---\n\n`
        );

        // Phase 4: final REDUCE step — stream the unified summary
        const reduceMessages = buildReduceMessages(finalSummaries, finalLabels, {
          url: ctx.url,
          videoTitle: ctx.videoTitle,
          videoChannel: ctx.videoChannel,
          instructions: ctx.instructions,
          language: ctx.language,
          actualStartTime: ctx.actualStartTime,
          actualEndTime: ctx.actualEndTime,
          totalSegments: ctx.totalSegments,
          totalChunks: chunks.length,
          inputKind,
        });
        const finalStream = await chatCompleteStream(reduceMessages, {
          maxTokens: 16000,
        });
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
