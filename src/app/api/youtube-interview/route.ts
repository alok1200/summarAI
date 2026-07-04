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
  type TranscriptChunk,
} from "@/lib/youtube-chunks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Difficulty = "beginner" | "intermediate" | "advanced" | "mixed";
type InterviewType = "technical" | "behavioral" | "mixed";

interface InterviewRequestBody {
  url: string;
  startTime?: string;
  endTime?: string;
  /** Optional: extra user instructions (e.g. "focus on React hooks") */
  instructions?: string;
  /** Optional: user-pasted transcript (bypasses auto-fetch) */
  transcript?: string;
  /** Difficulty level — defaults to "intermediate" */
  difficulty?: Difficulty;
  /** Number of questions — defaults to 15 */
  questionCount?: number;
  /** Interview type — defaults to "technical" */
  interviewType?: InterviewType;
  /** Optional: target role (e.g. "Senior React Developer") — improves question targeting */
  targetRole?: string;
  /** Optional: language for the AI response (e.g. "Hindi", "Spanish"). Empty = default English. */
  language?: string;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildSystemPrompt(
  difficulty: Difficulty,
  interviewType: InterviewType,
  questionCount: number,
  targetRole: string | undefined,
  language: string | undefined
): string {
  const difficultyDesc: Record<Difficulty, string> = {
    beginner:
      "Foundational questions on definitions, basic concepts, and common usage. Suitable for entry-level or junior candidates.",
    intermediate:
      "Application of concepts — common pitfalls, trade-offs, and reasoning. Suitable for mid-level candidates.",
    advanced:
      "Deep-dive questions on edge cases, architecture decisions, and complex reasoning. Suitable for senior candidates.",
    mixed:
      "A balanced mix of beginner, intermediate, and advanced questions so the candidate can practice progressively.",
  };

  const typeDesc: Record<InterviewType, string> = {
    technical:
      "Technical interview questions: coding, system design, algorithms, and domain-specific knowledge based on the video's content.",
    behavioral:
      "Behavioral / situational questions: past experience, soft skills, conflict resolution, teamwork — using the STAR method (Situation, Task, Action, Result).",
    mixed:
      "A balanced mix of technical and behavioral questions.",
  };

  return (
    `You are an expert interview coach who helps candidates prepare for job interviews.\n` +
    `You will be given a YouTube video transcript. Generate exactly ${questionCount} interview ` +
    `questions based on the video's content, then provide a detailed, interview-ready answer for each.\n\n` +
    `INTERVIEW PARAMETERS:\n` +
    `- Difficulty: ${difficulty} — ${difficultyDesc[difficulty]}\n` +
    `- Type: ${interviewType} — ${typeDesc[interviewType]}\n` +
    (targetRole ? `- Target role: ${targetRole}\n` : "") +
    `\nOUTPUT FORMAT — strictly follow this Markdown structure:\n\n` +
    `## Question 1: <short question title>\n` +
    `**Q:** <the full question>\n\n` +
    `**A:** <a 1-paragraph answer with reasoning and at least one concrete example ` +
    `or piece of evidence drawn from the video. Aim for 3-5 sentences.> ` +
    `End the answer with the [timestamp] in the transcript where this topic is discussed, ` +
    `copied EXACTLY as it appears (e.g. [3:25] or [1:25:30]).\n\n` +
    `> 💡 **Tip:** <one-line follow-up tip, common follow-up question, or pitfall to watch for>\n\n` +
    `---\n\n` +
    `## Question 2: ...\n\n` +
    `(continue for all ${questionCount} questions)\n\n` +
    `END WITH:\n\n` +
    `## 🎯 Quick Revision Cheat-Sheet\n` +
    `- <bullet 1: most important concept>\n` +
    `- <bullet 2: key formula / definition>\n` +
    `- <bullet 3: common mistake to avoid>\n` +
    `- <bullet 4: practical takeaway>\n` +
    `- <bullet 5: high-yield revision point>\n\n` +
    TIMESTAMP_RULES + `\n\n` +
    `RULES:\n` +
    `1. Every question MUST be answerable from the transcript content. Do NOT invent facts.\n` +
    `2. Number the questions 1..${questionCount} exactly. Do not skip numbers.\n` +
    `3. Use clear, simple language. Avoid filler phrases.\n` +
    `4. If the transcript is too short or off-topic, still produce your best ${questionCount} ` +
    `questions and note any limitations at the top.\n` +
    `5. Vary the question style (definition, application, comparison, scenario, debugging).\n` +
    `6. Every answer MUST cite at least one [timestamp] from the transcript where the topic is discussed. ` +
    TIMELINE_RULES +
    buildLanguageInstruction(language)
  );
}

/**
 * MAP step for long videos: extract question-worthy TOPICS from one chunk.
 * We don't generate the actual Q&A here — that would duplicate effort and
 * produce questions clustered around the chunk's local content. Instead we
 * extract a structured list of topics with timestamps, which the reduce step
 * uses to pick a balanced, diverse set of questions spanning the whole video.
 */
async function extractTopicsFromChunk(
  chunk: TranscriptChunk,
  ctx: {
    url: string;
    videoTitle: string | undefined;
    difficulty: Difficulty;
    interviewType: InterviewType;
    targetRole: string | undefined;
  }
): Promise<string> {
  // NOTE: topic extraction is intentionally language-agnostic — the topic
  // names are short labels used internally to pick which questions to ask.
  // The user-facing language is applied only in the final reduce step
  // (buildSystemPrompt) so the actual Q&A reads in the requested language.
  const systemPrompt =
    `You are an interview coach analyzing ONE segment of a long YouTube video. ` +
    `Your job: extract a structured list of question-worthy TOPICS from this segment. ` +
    `These topics will be merged with topics from other segments and used to generate ` +
    `the final interview questions, so be specific and cite timestamps.\n\n` +
    `For each topic, output a Markdown bullet in this exact format:\n` +
    `- [timestamp] **Topic name** — one-sentence description of what's covered and what kind of ` +
    `${ctx.interviewType} question could be asked about it at ${ctx.difficulty} difficulty.\n\n` +
    `The timestamp MUST be copied EXACTLY from the transcript prefix — same digits, same format ` +
    `([M:SS] for short videos, [H:MM:SS] for hour-plus videos). Do NOT invent or reformat timestamps.\n\n` +
    `Aim for 5-12 topics per segment. Pick the most question-worthy concepts, definitions, ` +
    `comparisons, decisions, and concrete examples mentioned in this segment. ` +
    `Do NOT generate the actual questions — just identify topics. Do NOT invent topics ` +
    `that aren't in the transcript.`;

  const userMessage =
    `Extract question-worthy topics from this segment of a YouTube video.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    `Segment: ${chunk.startTimeLabel} – ${chunk.endTimeLabel} ` +
    `(chunk ${chunk.index}/${chunk.total}, ${chunk.segmentCount} segments)\n` +
    `Target difficulty: ${ctx.difficulty}\n` +
    `Interview type: ${ctx.interviewType}\n` +
    (ctx.targetRole ? `Target role: ${ctx.targetRole}\n` : "") +
    `\nTranscript segment (timestamps are prefixed in [brackets] — copy them EXACTLY):\n\n${chunk.text}\n\n` +
    `List the topics now (Markdown bullets, each starting with a [timestamp] copied from the transcript).`;

  return await chatComplete([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
}

/**
 * REDUCE step for long videos: given the merged topic list from all chunks
 * + the per-chunk transcript texts (for citation), generate the final N
 * interview questions and answers. Streams the final result.
 */
function buildReduceMessages(
  chunks: TranscriptChunk[],
  topicLists: string[],
  ctx: {
    url: string;
    videoTitle: string | undefined;
    videoChannel: string | undefined;
    difficulty: Difficulty;
    interviewType: InterviewType;
    questionCount: number;
    targetRole: string | undefined;
    instructions: string | undefined;
    language: string | undefined;
    actualStartTime: number;
    actualEndTime: number;
    totalSegments: number;
  }
): ChatMessage[] {
  const systemPrompt = buildSystemPrompt(
    ctx.difficulty,
    ctx.interviewType,
    ctx.questionCount,
    ctx.targetRole,
    ctx.language
  );

  const mergedTopics = topicLists
    .map((topics, i) => {
      const c = chunks[i];
      return `### Topics from segment ${c.index}/${c.total} (${c.startTimeLabel} – ${c.endTimeLabel})\n\n${topics}`;
    })
    .join("\n\n---\n\n");

  const userMessage =
    `Generate exactly ${ctx.questionCount} ${ctx.interviewType} interview questions and answers ` +
    `at ${ctx.difficulty} difficulty for this YouTube video.\n\n` +
    `Video URL: ${ctx.url}\n` +
    (ctx.videoTitle ? `Video title: ${ctx.videoTitle}\n` : "") +
    (ctx.videoChannel ? `Video channel: ${ctx.videoChannel}\n` : "") +
    `Total time range: ${formatTime(ctx.actualStartTime)} – ${formatTime(ctx.actualEndTime)} ` +
    `(${ctx.totalSegments} segments across ${chunks.length} chunks)\n\n` +
    (ctx.instructions ? `Additional instructions: ${ctx.instructions}\n\n` : "") +
    `Below are question-worthy TOPICS extracted from each segment of the video (with timestamps). ` +
    `Use these topics as your source of truth for what the video covers. Pick a DIVERSE, balanced ` +
    `set of ${ctx.questionCount} questions spanning different segments of the video — do not cluster ` +
    `all questions around one segment. Each answer MUST cite the relevant [timestamp] copied EXACTLY ` +
    `from the topic list (e.g. [3:25] or [1:25:30] — match the format you see).\n\n` +
    `--- TOPIC LIST (per segment) ---\n\n${mergedTopics}\n\n` +
    `--- END TOPIC LIST ---\n\n` +
    `Now generate the ${ctx.questionCount} questions and answers following the format from the system prompt.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

export async function POST(req: NextRequest) {
  let parsedVideoId: string | null = null;
  try {
    const body = (await req.json()) as InterviewRequestBody;
    const url: string = body.url ?? "";
    const startTimeStr: string = body.startTime ?? "";
    const endTimeStr: string = body.endTime ?? "";
    const instructions: string = (body.instructions ?? "").trim();
    const manualTranscript: string = (body.transcript ?? "").trim();

    const difficulty: Difficulty =
      (body.difficulty as Difficulty) || "intermediate";
    const questionCount = Math.min(
      Math.max(parseInt(String(body.questionCount ?? "15"), 10) || 15, 5),
      30
    );
    const interviewType: InterviewType =
      (body.interviewType as InterviewType) || "technical";
    const targetRole: string | undefined = body.targetRole?.trim() || undefined;
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

    const videoMeta: VideoMeta | null = await fetchVideoMeta(videoId);

    const sourceLabel = isManual ? " (manual paste)" : "";
    const header =
      `**🎤 Interview Q&A${sourceLabel}**\n\n` +
      (videoMeta
        ? `**Title:** ${videoMeta.title}\n**Channel:** ${videoMeta.author}\n`
        : "") +
      `**URL:** ${url}\n` +
      `**Time range:** ${formatTime(actualStartTime)} – ${formatTime(
        actualEndTime
      )}  ·  ${filtered.length} transcript segments\n` +
      `**Difficulty:** ${difficulty}  ·  **Type:** ${interviewType}  ·  **Questions:** ${questionCount}\n` +
      (targetRole ? `**Target role:** ${targetRole}\n` : "") +
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

      const systemPrompt = buildSystemPrompt(
        difficulty,
        interviewType,
        questionCount,
        targetRole,
        language || undefined
      );

      const userMessage =
        `Generate ${questionCount} ${interviewType} interview questions and answers ` +
        `at ${difficulty} difficulty based on the following YouTube video transcript.\n\n` +
        `Video URL: ${url}\n` +
        (videoMeta
          ? `Video title: ${videoMeta.title}\nVideo channel: ${videoMeta.author}\n`
          : "") +
        `Selected time range: ${formatTime(actualStartTime)} – ${formatTime(
          actualEndTime
        )}  (about ${Math.round(actualEndTime - actualStartTime)}s, ${
          filtered.length
        } segments)\n\n` +
        (instructions
          ? `Additional instructions from the user: ${instructions}\n\n`
          : "") +
        `Transcript (with timestamps):\n\n${transcriptText}\n\n` +
        `Please generate the ${questionCount} questions and answers now, following the format from the system prompt.`;

      console.log(
        `[youtube-interview] Generating ${questionCount} ${difficulty} ${interviewType} questions for ${videoId} (single-call)`
      );

      const llmStream = await chatCompleteStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);
      return streamHeaderAndLLM(header, llmStream);
    }

    // ---------- Long video: MAP-REDUCE with parallel topic extraction ----------
    const chunks = chunkTranscript(filtered);
    console.log(
      `[youtube-interview] MAP-REDUCE: ${filtered.length} segments → ${chunks.length} chunks (parallel) for ${videoId}`
    );

    const mapCtx = {
      url,
      videoTitle: videoMeta?.title,
      difficulty,
      interviewType,
      targetRole,
    };
    const reduceCtx = {
      url,
      videoTitle: videoMeta?.title,
      videoChannel: videoMeta?.author,
      difficulty,
      interviewType,
      questionCount,
      targetRole,
      instructions: instructions || undefined,
      language: language || undefined,
      actualStartTime,
      actualEndTime,
      totalSegments: filtered.length,
    };

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
            `(extracting topics from each ~5-10 min segment, then generating ` +
            `${questionCount} balanced questions spanning the whole video).\n\n`
        );

        // Phase 2: parallel map step (extract topics from each chunk)
        const topicLists = await mapChunks(
          chunks,
          (chunk) => extractTopicsFromChunk(chunk, mapCtx),
          (done, total) => {
            emit(`✅ Chunk ${done}/${total} analyzed\n`);
          }
        );

        emit(`\n🎯 **Generating ${questionCount} questions from ${chunks.length * 5}+ topics…**\n\n---\n\n`);

        // Phase 3: reduce step — stream the final Q&A
        const reduceMessages = buildReduceMessages(chunks, topicLists, reduceCtx);
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
    console.error("[youtube-interview] error:", message, "code:", code);

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
    // Friendlier message for transient gateway errors so the user knows to retry
    const friendlyMsg = /502|503|504|bad gateway|service unavailable|gateway timeout|upstream/i.test(
      message
    )
      ? "The AI service is temporarily unavailable (gateway error). Please try again in a few seconds — your request will be retried automatically on the next attempt."
      : message || "Interview Q&A generation failed.";
    return jsonResponse(500, {
      error: friendlyMsg,
      videoMeta: metaPayload,
    });
  }
}
