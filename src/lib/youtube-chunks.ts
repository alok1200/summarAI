import { type TranscriptSegment } from "./youtube-transcript";
import { formatTime } from "./youtube-transcript";

/**
 * Chunking + map-reduce utilities for handling VERY LONG YouTube videos
 * (multi-hour lectures, livestreams, podcasts, etc. — up to 50+ hours).
 *
 * Problem: A 50-hour video has ~500,000+ characters of transcript. We can't
 * feed that into a single LLM call (context limit + huge latency + huge cost).
 *
 * Solution: "Map-reduce" —
 *   1. Split the transcript into ~25K-char chunks at segment boundaries
 *      (so each chunk starts/ends on a sentence boundary with timestamps).
 *   2. Process each chunk IN PARALLEL with its own LLM call (map step).
 *      For 8 chunks, this takes the same wall time as 1 chunk, not 8x.
 *   3. Combine the per-chunk outputs into a final unified answer (reduce step).
 *
 * Each chunk is small enough (~5 min of video) that an individual LLM call
 * finishes in 2-5 seconds. With 8-way parallelism, an 8-chunk video processes
 * in ~5 seconds total instead of 40+ seconds sequentially.
 */

/** Target chunk size in characters. Smaller = more parallelism + faster per-chunk LLM call. */
const TARGET_CHUNK_CHARS = 22000;
/** Hard max chunk size — never exceed this even if a single segment is huge. */
const MAX_CHUNK_CHARS = 28000;
/** Don't create a tiny trailing chunk — merge anything smaller than this into the previous one. */
const MIN_FINAL_CHUNK_CHARS = 4000;

export interface TranscriptChunk {
  /** 1-indexed chunk number for display. */
  index: number;
  /** Total number of chunks. */
  total: number;
  /** Start time of the first segment in this chunk, in seconds. */
  startTime: number;
  /** End time of the last segment in this chunk (start + dur), in seconds. */
  endTime: number;
  /** Segment count. */
  segmentCount: number;
  /** Formatted "MM:SS" start time. */
  startTimeLabel: string;
  /** Formatted "MM:SS" end time. */
  endTimeLabel: string;
  /** The chunk's transcript text, with [MM:SS] prefixes preserved. */
  text: string;
}

/**
 * Split transcript segments into chunks, each roughly TARGET_CHUNK_CHARS in
 * size, sliced at segment boundaries (so we never split mid-sentence).
 *
 * Each chunk's text preserves the `[MM:SS] text` format so the LLM still
 * sees timestamps for citing.
 */
export function chunkTranscript(
  segments: TranscriptSegment[]
): TranscriptChunk[] {
  if (segments.length === 0) return [];

  const chunks: TranscriptChunk[] = [];
  let currentSegs: TranscriptSegment[] = [];
  let currentText = "";

  const flush = () => {
    if (currentSegs.length === 0) return;
    const first = currentSegs[0];
    const last = currentSegs[currentSegs.length - 1];
    chunks.push({
      index: 0, // assigned after all chunks collected
      total: 0,
      startTime: first.start,
      endTime: last.start + last.dur,
      segmentCount: currentSegs.length,
      startTimeLabel: formatTime(first.start),
      endTimeLabel: formatTime(last.start + last.dur),
      text: currentText,
    });
    currentSegs = [];
    currentText = "";
  };

  for (const seg of segments) {
    const line = `[${formatTime(seg.start)}] ${seg.text}\n`;
    // If adding this line would overflow the max, flush first.
    if (
      currentText.length + line.length > MAX_CHUNK_CHARS &&
      currentSegs.length > 0
    ) {
      flush();
    }
    currentSegs.push(seg);
    currentText += line;
    // If we've reached the target size, flush proactively.
    if (currentText.length >= TARGET_CHUNK_CHARS) {
      flush();
    }
  }
  flush();

  // Merge any tiny trailing chunk into the previous one to avoid a wasted
  // LLM call on a few sentences.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (last.text.length < MIN_FINAL_CHUNK_CHARS) {
      const prev = chunks[chunks.length - 2];
      prev.text += last.text;
      prev.endTime = last.endTime;
      prev.endTimeLabel = last.endTimeLabel;
      prev.segmentCount += last.segmentCount;
      chunks.pop();
    }
  }

  // Assign 1-indexed numbers and totals.
  const total = chunks.length;
  chunks.forEach((c, i) => {
    c.index = i + 1;
    c.total = total;
  });

  return chunks;
}

/**
 * Run an async function on each chunk IN PARALLEL (with a small concurrency
 * limit to avoid overwhelming the LLM gateway), collecting the results in
 * chunk order.
 *
 * @param chunks  The chunks to process.
 * @param fn      Async function taking a chunk and returning its result.
 * @param onProgress  Optional callback invoked when each chunk completes.
 *                    Receives (chunkIndex, totalChunks, partialResult).
 * @param concurrency  Max simultaneous in-flight calls (default 6).
 */
export async function mapChunks<T>(
  chunks: TranscriptChunk[],
  fn: (chunk: TranscriptChunk) => Promise<T>,
  onProgress?: (index: number, total: number, result: T) => void,
  concurrency = 4
): Promise<T[]> {
  const results: T[] = new Array(chunks.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      try {
        const r = await fn(chunk);
        results[idx] = r;
        completed++;
        if (onProgress) onProgress(completed, chunks.length, r);
      } catch (err) {
        // If one chunk fails, put a placeholder error string into results
        // so the reduce step can still proceed with the others.
        const errMsg =
          err instanceof Error ? err.message : "Unknown chunk error";
        console.error(`[mapChunks] chunk ${chunk.index} failed:`, errMsg);
        results[idx] = `_(Chunk ${chunk.index} failed: ${errMsg})_` as unknown as T;
        completed++;
        if (onProgress) onProgress(completed, chunks.length, results[idx]);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Decide whether a transcript is "long" enough to need map-reduce.
 * Below this threshold, a single LLM call is faster and gives a more
 * coherent answer.
 */
export function shouldUseMapReduce(
  segments: TranscriptSegment[],
  thresholdChars = 60000
): boolean {
  // Quick character estimate without building the full text.
  let est = 0;
  for (const s of segments) {
    est += s.text.length + 12; // 12 = "[MM:SS] " prefix + newline
    if (est >= thresholdChars) return true;
  }
  return false;
}

/**
 * Estimate the number of chunks a transcript will produce, for display
 * purposes (e.g. "Processing 8 chunks in parallel…").
 */
export function estimateChunkCount(
  segments: TranscriptSegment[],
  target = TARGET_CHUNK_CHARS
): number {
  let totalChars = 0;
  for (const s of segments) {
    totalChars += s.text.length + 12;
  }
  return Math.max(1, Math.ceil(totalChars / target));
}
