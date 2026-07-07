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
import {
  chunkTranscript,
  shouldUseMapReduce,
  mapChunks,
  type TranscriptChunk,
} from "@/lib/youtube-chunks";
import { chatComplete } from "@/lib/llm";
import { requireAuth } from "@/lib/require-auth";
import { rateLimit, aiRateLimitConfig } from "@/lib/rate-limit";
import { readJsonBody, sanitizeError } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { embedBatch, embeddingToBuffer } from "@/lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoadRequestBody {
  url: string;
  startTime?: string;
  endTime?: string;
  /** Optional: user-pasted transcript (bypasses auto-fetch) */
  transcript?: string;
  /**
   * Optional: language for the AI's responses during ask-about-video Q&A.
   * youtube-load itself doesn't generate user-facing text (the topic index
   * it builds is internal retrieval metadata), so we accept but ignore this
   * field. The client stores it on the videoContext and threads it to
   * /api/chat, which is where the language instruction actually gets
   * injected into the system prompt.
   */
  language?: string;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Persist (or look up) a transcript + its chunks for the current user.
 *
 * - If a Transcript for (userId, videoId) already exists, return its id
 *   WITHOUT re-embedding — embeddings are idempotent and expensive.
 * - Otherwise create the Transcript row + one TranscriptChunk row per chunk,
 *   then kick off embedding in the background (non-blocking — we return
 *   the response immediately so the user doesn't wait ~30s for embeddings).
 *
 * For short videos (single transcript string), we still persist one chunk
 * with the whole text — this lets future "search across my videos" work
 * uniformly.
 *
 * Returns the transcriptId. Callers can ignore it (the chat endpoint will
 * look up the transcript by userId+videoId at request time).
 */
async function persistTranscript(
  userId: string,
  videoId: string,
  title: string,
  author: string | undefined,
  chunks: { index: number; text: string }[],
  transcriptText?: string
): Promise<string> {
  // Check for existing transcript — if it exists, return its id without
  // re-persisting or re-embedding.
  const existing = await db.transcript.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { id: true, embedded: true },
  });
  if (existing) {
    logger.info("youtube-load.transcript_cached", {
      userId,
      videoId,
      transcriptId: existing.id,
      alreadyEmbedded: existing.embedded,
    });

    // If the existing transcript isn't embedded yet, kick off embedding
    // in the background — it might have been created by an earlier version
    // of this code, or embedding failed last time.
    if (!existing.embedded) {
      void embedTranscriptInBackground(existing.id);
    }

    return existing.id;
  }

  // Create new Transcript + chunks in a single transaction.
  // Use the single transcript text as chunk[0] for short videos, or the
  // explicit chunks for long videos.
  const finalChunks =
    chunks.length > 0
      ? chunks
      : transcriptText
      ? [{ index: 0, text: transcriptText }]
      : [];

  const lengthChars = finalChunks.reduce((sum, c) => sum + c.text.length, 0);

  const transcript = await db.transcript.create({
    data: {
      userId,
      videoId,
      title,
      author,
      lengthChars,
      chunkCount: finalChunks.length,
      embedded: false,
      chunks: {
        create: finalChunks.map((c) => ({
          chunkIndex: c.index,
          text: c.text,
          embedding: null, // set by background embedding
        })),
      },
    },
  });

  logger.info("youtube-load.transcript_persisted", {
    userId,
    videoId,
    transcriptId: transcript.id,
    chunkCount: finalChunks.length,
    lengthChars,
  });

  // Kick off embedding in the background. Don't await — the user gets
  // their response immediately; embeddings will be ready by the time
  // they ask their first question (or by their next session).
  void embedTranscriptInBackground(transcript.id);

  return transcript.id;
}

/**
 * Background-embed all chunks of a transcript.
 *
 * This function is fire-and-forget — it's called with `void` from
 * persistTranscript() so the request doesn't block on embedding.
 *
 * Flow:
 *   1. Load all chunks for the transcript (without embeddings, since they're null)
 *   2. Call embedBatch() — handles batching + parallelism internally
 *   3. Update each chunk's embedding column
 *   4. Set transcript.embedded = true
 *
 * Errors are logged but not thrown — the user's request already succeeded.
 * If embedding fails, the chat endpoint will fall back to LLM-as-retriever.
 */
async function embedTranscriptInBackground(transcriptId: string): Promise<void> {
  try {
    const chunks = await db.transcriptChunk.findMany({
      where: { transcriptId, embedding: null },
      orderBy: { chunkIndex: "asc" },
      select: { id: true, text: true },
    });

    if (chunks.length === 0) {
      // All chunks already embedded — just mark the transcript as embedded.
      await db.transcript.update({
        where: { id: transcriptId },
        data: { embedded: true },
      });
      return;
    }

    logger.info("embeddings.background.start", {
      transcriptId,
      chunkCount: chunks.length,
    });

    const embeddings = await embedBatch(chunks.map((c) => c.text));

    // Update each chunk in parallel (small N, safe to do in-memory)
    await Promise.all(
      embeddings.map((emb, i) => {
        if (!emb) return Promise.resolve();
        return db.transcriptChunk.update({
          where: { id: chunks[i].id },
          data: { embedding: embeddingToBuffer(emb) },
        });
      })
    );

    await db.transcript.update({
      where: { id: transcriptId },
      data: { embedded: true },
    });

    const successCount = embeddings.filter((e) => e !== null).length;
    logger.info("embeddings.background.complete", {
      transcriptId,
      success: successCount,
      failed: chunks.length - successCount,
    });
  } catch (err) {
    logger.error("embeddings.background.error", {
      transcriptId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't rethrow — this is fire-and-forget.
  }
}

/**
 * Build a topic index for a long video by extracting topics from each chunk
 * in parallel. The resulting index is small (~5-12 topics per chunk = a few
 * KB total even for a 50-hour video) and is what the Q&A retrieval step
 * searches to decide which chunks to actually load for a given question.
 */
async function buildTopicIndex(
  chunks: TranscriptChunk[],
  videoTitle: string | undefined
): Promise<string> {
  const topics = await mapChunks(
    chunks,
    async (chunk) => {
      const systemPrompt =
        `You are indexing a long YouTube video for question answering. ` +
        `Your job: extract a concise list of TOPICS covered in this segment. ` +
        `These will be used to decide which segment to load when the user asks a question.\n\n` +
        `Output format — one bullet per topic, EXACTLY this format:\n` +
        `- [start]–[end] Topic name — short description\n\n` +
        `The [start] and [end] timestamps MUST be copied EXACTLY from the transcript prefix — ` +
        `same digits, same format ([M:SS] for short videos, [H:MM:SS] for hour-plus videos). ` +
        `Do NOT invent or reformat timestamps. Use the timestamp of the first segment line as ` +
        `[start] and the timestamp of the last segment line covering this topic as [end].\n\n` +
        `Aim for 5-10 topics. Use specific noun phrases (e.g. "useEffect cleanup function", ` +
        `"useState batching behavior") not vague categories. Do NOT include topics not in the transcript.`;

      const userMessage =
        `Extract topics from this segment of a YouTube video.\n` +
        (videoTitle ? `Video title: ${videoTitle}\n` : "") +
        `Segment: ${chunk.startTimeLabel} – ${chunk.endTimeLabel} (chunk ${chunk.index}/${chunk.total})\n\n` +
        `Transcript:\n${chunk.text}\n\nList the topics now.`;

      return await chatComplete([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);
    },
    undefined,
    6
  );

  return topics
    .map((t, i) => {
      const c = chunks[i];
      return `## Chunk ${c.index}/${c.total} (${c.startTimeLabel} – ${c.endTimeLabel})\n${t}`;
    })
    .join("\n\n");
}

/**
 * Loads a YouTube video's transcript (auto-fetch with multi-strategy fallback,
 * or accepts a user-pasted transcript) and returns it as JSON along with the
 * video's metadata. Used by the "Ask about video" mode in the chat UI to
 * pre-load the transcript into the conversation context before the user starts
 * asking questions.
 *
 * For LONG videos (> ~60K chars of transcript, about 10+ minutes):
 *   - Splits the transcript into chunks (~5-10 min each)
 *   - Builds a topic index in parallel (one LLM call per chunk)
 *   - Returns the chunks + topic index instead of one giant truncated string
 *   - The /api/chat route then does RETRIEVAL: finds the most relevant
 *     chunks for each user question and injects only those — so even a
 *     50-hour video can be queried accurately.
 *
 * For SHORT videos:
 *   - Returns the full transcript as a single string (legacy behavior)
 *   - The /api/chat route injects the whole thing as system context.
 */
export async function POST(req: NextRequest) {
  // ---------- AUTH ----------
  const guard = await requireAuth(req);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  // ---------- RATE LIMIT ----------
  const rl = rateLimit(aiRateLimitConfig(user.id, "youtube-load"));
  if (!rl.ok) {
    logger.warn("youtube-load.rate_limited", { userId: user.id });
    return rl.response;
  }

  // ---------- BODY ----------
  const bodyResult = await readJsonBody<LoadRequestBody>(req, 2 * 1024 * 1024);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.value;

  const requestId = req.headers.get("x-request-id") ?? "no-req-id";
  logger.info("youtube-load.request", {
    userId: user.id,
    requestId,
    hasUrl: !!body.url,
    hasManualTranscript: !!body.transcript,
  });

  let parsedVideoId: string | null = null;
  try {
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

    const videoMeta = await fetchVideoMeta(videoId);
    const videoTitle = videoMeta?.title ?? "Unknown title";
    const videoAuthor = videoMeta?.author ?? "Unknown channel";

    // Decide: short video (single transcript string) vs long video (chunks + topic index)
    const useChunks = shouldUseMapReduce(filtered);

    if (!useChunks) {
      // ---------- Short video: return single transcript string ----------
      const transcriptText = filtered
        .map((s) => `[${formatTime(s.start)}] ${s.text}`)
        .join("\n");

      // Persist transcript + kick off background embedding (non-blocking).
      // For short videos we store the whole transcript as a single chunk —
      // enables future "search across my videos" features.
      try {
        await persistTranscript(
          user.id,
          videoId,
          videoTitle,
          videoAuthor,
          [], // no chunks — pass as single text
          transcriptText
        );
      } catch (err) {
        // Persistence failure should NOT break the user's request — log
        // and continue. Vector search just won't be available.
        logger.error("youtube-load.persist_failed", {
          userId: user.id,
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return jsonResponse(200, {
        ok: true,
        videoId,
        url,
        title: videoTitle,
        author: videoAuthor,
        thumbnailUrl: videoMeta?.thumbnailUrl,
        isManual,
        startTime: actualStartTime,
        endTime: actualEndTime,
        segmentCount: filtered.length,
        rangeNote,
        // Single-string transcript — /api/chat will inject it whole.
        transcript: transcriptText,
        // No chunks for short videos
        chunks: null,
        topicIndex: null,
      });
    }

    // ---------- Long video: chunk + build topic index ----------
    console.log(
      `[youtube-load] Long video detected: ${filtered.length} segments → chunking + topic indexing`
    );
    const chunks = chunkTranscript(filtered);
    const topicIndex = await buildTopicIndex(chunks, videoTitle);

    // Persist transcript + chunks, kick off background embedding.
    try {
      await persistTranscript(
        user.id,
        videoId,
        videoTitle,
        videoAuthor,
        chunks.map((c) => ({ index: c.index, text: c.text }))
      );
    } catch (err) {
      logger.error("youtube-load.persist_failed", {
        userId: user.id,
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Return chunks as an array of { startTime, endTime, startTimeLabel, endTimeLabel, text }
    const chunksPayload = chunks.map((c) => ({
      index: c.index,
      total: c.total,
      startTime: c.startTime,
      endTime: c.endTime,
      startTimeLabel: c.startTimeLabel,
      endTimeLabel: c.endTimeLabel,
      segmentCount: c.segmentCount,
      text: c.text,
    }));

    return jsonResponse(200, {
      ok: true,
      videoId,
      url,
      title: videoTitle,
      author: videoAuthor,
      thumbnailUrl: videoMeta?.thumbnailUrl,
      isManual,
      startTime: actualStartTime,
      endTime: actualEndTime,
      segmentCount: filtered.length,
      rangeNote,
      // For long videos, transcript is null — /api/chat must use chunks + topicIndex
      transcript: null,
      chunks: chunksPayload,
      topicIndex,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = (err as { code?: string })?.code;
    logger.error("youtube-load.failed", {
      userId: user.id,
      requestId,
      error: message,
      code,
      videoId: parsedVideoId,
    });

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
      digest: sanitizeError(err).digest,
    });
  }
}
