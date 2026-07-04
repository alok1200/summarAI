import { describe, it, expect } from "bun:test";
import {
  chunkTranscript,
  shouldUseMapReduce,
  estimateChunkCount,
  planReduce,
  groupLabel,
  mapChunks,
  REDUCE_THRESHOLD,
  SECTION_GROUP_SIZE,
  type TranscriptChunk,
} from "../youtube-chunks";
import type { TranscriptSegment } from "../youtube-transcript";

// Helper: synthesize N segments of M chars each.
function makeSegments(
  count: number,
  charsPerSeg = 100
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      start: i * 10,
      dur: 10,
      text: "x".repeat(charsPerSeg),
    });
  }
  return out;
}

describe("chunkTranscript", () => {
  it("returns empty array for empty input", () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  it("produces a single chunk for short transcripts", () => {
    const segs = makeSegments(5, 100); // ~500 chars total
    const chunks = chunkTranscript(segs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(1);
    expect(chunks[0].total).toBe(1);
    expect(chunks[0].segmentCount).toBe(5);
    expect(chunks[0].startTime).toBe(0);
    expect(chunks[0].endTime).toBe(50); // last seg (start=40, dur=10) → end=50
  });

  it("splits long transcripts into multiple chunks at segment boundaries", () => {
    // 100 segments × ~25000 chars each → way over MAX_CHUNK_CHARS (28000)
    // so each segment becomes its own chunk (until target reached).
    // Use realistic sizes: 100 segs × 500 chars = 50000 chars → ~3 chunks
    const segs = makeSegments(100, 500);
    const chunks = chunkTranscript(segs);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should have index/total assigned consistently.
    const total = chunks[0].total;
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i + 1);
      expect(c.total).toBe(total);
      expect(c.total).toBe(chunks.length);
    });
  });

  it("merges a tiny trailing chunk into the previous one", () => {
    // 3 segments: 2 huge + 1 tiny. After chunking, the tiny one should be
    // merged into chunk 2 so we don't waste an LLM call on 1 sentence.
    const segs: TranscriptSegment[] = [
      { start: 0, dur: 10, text: "x".repeat(22000) },
      { start: 10, dur: 10, text: "x".repeat(22000) },
      { start: 20, dur: 10, text: "x".repeat(50) }, // tiny
    ];
    const chunks = chunkTranscript(segs);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].text).toContain("x".repeat(50));
  });

  it("preserves [MM:SS] prefixes in chunk text", () => {
    const segs: TranscriptSegment[] = [
      { start: 0, dur: 5, text: "Hello" },
      { start: 10, dur: 5, text: "World" },
    ];
    const chunks = chunkTranscript(segs);
    expect(chunks[0].text).toContain("[0:00] Hello");
    expect(chunks[0].text).toContain("[0:10] World");
  });

  it("assigns correct startTimeLabel / endTimeLabel for short videos", () => {
    const segs: TranscriptSegment[] = [
      { start: 0, dur: 5, text: "a" },
      { start: 205, dur: 5, text: "b" },
    ];
    const chunks = chunkTranscript(segs);
    expect(chunks[0].startTimeLabel).toBe("0:00");
    expect(chunks[0].endTimeLabel).toBe("3:30");
  });

  it("assigns correct startTimeLabel / endTimeLabel for hour+ videos", () => {
    const segs: TranscriptSegment[] = [
      { start: 5130, dur: 5, text: "a" }, // 1:25:30
      { start: 7514, dur: 5, text: "b" }, // 2:05:14 ... wait, end is start+dur
    ];
    const chunks = chunkTranscript(segs);
    expect(chunks[0].startTimeLabel).toBe("1:25:30");
    // endTimeLabel is last.start + last.dur = 7514 + 5 = 7519 → 2:05:19
    expect(chunks[0].endTimeLabel).toBe("2:05:19");
  });
});

describe("shouldUseMapReduce", () => {
  it("returns false for short transcripts", () => {
    expect(shouldUseMapReduce(makeSegments(10, 100))).toBe(false);
  });

  it("returns true once the threshold is crossed", () => {
    // 60000 / (100 + 12) ≈ 536 segments needed
    expect(shouldUseMapReduce(makeSegments(600, 100))).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(shouldUseMapReduce(makeSegments(5, 100), 400)).toBe(true);
    expect(shouldUseMapReduce(makeSegments(2, 100), 400)).toBe(false);
  });

  it("short-circuits as soon as the threshold is hit", () => {
    // 1 million segments — must not loop through all of them
    const segs = makeSegments(1_000_000, 100);
    expect(shouldUseMapReduce(segs)).toBe(true);
  });
});

describe("estimateChunkCount", () => {
  it("returns at least 1", () => {
    expect(estimateChunkCount([])).toBeGreaterThanOrEqual(1);
  });

  it("estimates proportional to total chars", () => {
    const small = estimateChunkCount(makeSegments(10, 100));
    const large = estimateChunkCount(makeSegments(1000, 100));
    expect(large).toBeGreaterThan(small);
  });

  it("accepts a custom target chunk size", () => {
    const segs = makeSegments(100, 1000); // 100K chars
    expect(estimateChunkCount(segs, 5000)).toBeGreaterThan(
      estimateChunkCount(segs, 22000)
    );
  });
});

describe("planReduce", () => {
  it("returns hierarchical=false when chunk count ≤ threshold", () => {
    const chunks: TranscriptChunk[] = Array.from(
      { length: REDUCE_THRESHOLD },
      (_, i) => ({
        index: i + 1,
        total: REDUCE_THRESHOLD,
        startTime: 0,
        endTime: 100,
        segmentCount: 1,
        startTimeLabel: "0:00",
        endTimeLabel: "1:40",
        text: "x",
      })
    );
    const plan = planReduce(chunks);
    expect(plan.hierarchical).toBe(false);
    expect(plan.groups).toBeUndefined();
  });

  it("returns hierarchical=true when chunk count > threshold", () => {
    const n = REDUCE_THRESHOLD + 5;
    const chunks: TranscriptChunk[] = Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      total: n,
      startTime: i * 100,
      endTime: (i + 1) * 100,
      segmentCount: 1,
      startTimeLabel: "0:00",
      endTimeLabel: "1:40",
      text: "x",
    }));
    const plan = planReduce(chunks);
    expect(plan.hierarchical).toBe(true);
    expect(plan.groups).toBeDefined();
    expect(plan.groups!.length).toBe(Math.ceil(n / SECTION_GROUP_SIZE));
  });

  it("groups are contiguous slices", () => {
    const n = 15;
    const chunks: TranscriptChunk[] = Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      total: n,
      startTime: i * 100,
      endTime: (i + 1) * 100,
      segmentCount: 1,
      startTimeLabel: "0:00",
      endTimeLabel: "1:40",
      text: `chunk-${i + 1}`,
    }));
    const plan = planReduce(chunks);
    expect(plan.groups).toBeDefined();
    // First group should be chunks 1..SECTION_GROUP_SIZE
    expect(plan.groups![0][0].text).toBe("chunk-1");
    expect(plan.groups![0][SECTION_GROUP_SIZE - 1].text).toBe(
      `chunk-${SECTION_GROUP_SIZE}`
    );
    // Last group should start at chunk SECTION_GROUP_SIZE+1
    expect(plan.groups![1][0].text).toBe(`chunk-${SECTION_GROUP_SIZE + 1}`);
  });
});

describe("groupLabel", () => {
  it("formats a label spanning multiple chunks", () => {
    const group: TranscriptChunk[] = [
      {
        index: 3,
        total: 10,
        startTime: 200,
        endTime: 300,
        segmentCount: 1,
        startTimeLabel: "3:20",
        endTimeLabel: "5:00",
        text: "x",
      },
      {
        index: 4,
        total: 10,
        startTime: 300,
        endTime: 400,
        segmentCount: 1,
        startTimeLabel: "5:00",
        endTimeLabel: "6:40",
        text: "x",
      },
    ];
    const label = groupLabel(group);
    expect(label).toContain("3:20");
    expect(label).toContain("6:40");
    expect(label).toContain("chunks 3–4 of 10");
  });
});

describe("mapChunks", () => {
  it("runs the mapper on every chunk and returns results in order", async () => {
    const chunks: TranscriptChunk[] = Array.from({ length: 5 }, (_, i) => ({
      index: i + 1,
      total: 5,
      startTime: 0,
      endTime: 0,
      segmentCount: 0,
      startTimeLabel: "0:00",
      endTimeLabel: "0:00",
      text: `c${i + 1}`,
    }));
    const results = await mapChunks(chunks, async (c) => c.text.toUpperCase());
    expect(results).toEqual(["C1", "C2", "C3", "C4", "C5"]);
  });

  it("calls onProgress for each completed chunk", async () => {
    const chunks: TranscriptChunk[] = Array.from({ length: 4 }, (_, i) => ({
      index: i + 1,
      total: 4,
      startTime: 0,
      endTime: 0,
      segmentCount: 0,
      startTimeLabel: "0:00",
      endTimeLabel: "0:00",
      text: "x",
    }));
    const progress: Array<{ done: number; total: number }> = [];
    await mapChunks(
      chunks,
      async () => "ok",
      (done, total) => progress.push({ done, total })
    );
    expect(progress).toHaveLength(4);
    expect(progress[0].total).toBe(4);
    expect(progress.at(-1)!.done).toBe(4);
  });

  it("replaces failed chunks with placeholder strings (does not throw)", async () => {
    const chunks: TranscriptChunk[] = Array.from({ length: 3 }, (_, i) => ({
      index: i + 1,
      total: 3,
      startTime: 0,
      endTime: 0,
      segmentCount: 0,
      startTimeLabel: "0:00",
      endTimeLabel: "0:00",
      text: "x",
    }));
    const results = await mapChunks(chunks, async (c) => {
      if (c.index === 2) throw new Error("boom");
      return "ok";
    });
    expect(results[0]).toBe("ok");
    expect(String(results[1])).toContain("Chunk 2 failed");
    expect(String(results[1])).toContain("boom");
    expect(results[2]).toBe("ok");
  });

  it("respects the concurrency limit (at most N in-flight)", async () => {
    const chunks: TranscriptChunk[] = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      total: 10,
      startTime: 0,
      endTime: 0,
      segmentCount: 0,
      startTimeLabel: "0:00",
      endTimeLabel: "0:00",
      text: "x",
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapChunks(
      chunks,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return "ok";
      },
      undefined,
      3 // concurrency limit
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r === "ok")).toBe(true);
  });
});
