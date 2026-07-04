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
  targetRole: string | undefined
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
    `or piece of evidence drawn from the video. Aim for 3-5 sentences.>\n\n` +
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
    `RULES:\n` +
    `1. Every question MUST be answerable from the transcript content. Do NOT invent facts.\n` +
    `2. Number the questions 1..${questionCount} exactly. Do not skip numbers.\n` +
    `3. Use clear, simple English. Avoid filler phrases.\n` +
    `4. If the transcript is too short or off-topic, still produce your best ${questionCount} ` +
    `questions and note any limitations at the top.\n` +
    `5. Vary the question style (definition, application, comparison, scenario, debugging).\n`
  );
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

    const systemPrompt = buildSystemPrompt(
      difficulty,
      interviewType,
      questionCount,
      targetRole
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
      `Transcript (with timestamps):\n\n${truncated}\n\n` +
      `Please generate the ${questionCount} questions and answers now, following the format from the system prompt.`;

    console.log(
      `[youtube-interview] Generating ${questionCount} ${difficulty} ${interviewType} questions for ${videoId}`
    );

    // REAL STREAMING: pipe the LLM's streaming response directly so the
    // first token reaches the browser in ~1 second. This prevents the
    // preview proxy from returning 502 on long generations (15-question
    // interview Q&A can take 60+ seconds non-streaming).
    const llmStream = await chatCompleteStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

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
      `\n---\n\n`;

    return streamHeaderAndLLM(header, llmStream);
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
