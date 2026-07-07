import { describe, test, expect } from "bun:test";
import {
  cosineSimilarity,
  topK,
} from "@/lib/vector-search";
import {
  embeddingToBuffer,
  bufferToEmbedding,
  EMBEDDING_DIM,
} from "@/lib/embeddings";

describe("embedding serialization", () => {
  test("EMBEDDING_DIM is 384 (all-MiniLM-L6-v2)", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });

  test("embeddingToBuffer + bufferToEmbedding round-trip preserves values", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, -0.4, 0.5]);
    const buf = embeddingToBuffer(original);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBe(20); // 5 floats × 4 bytes

    const restored = bufferToEmbedding(buf);
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(restored![i]).toBeCloseTo(original[i], 5);
    }
  });

  test("embeddingToBuffer handles 384-dim vectors (full MiniLM output)", () => {
    const original = new Float32Array(384);
    for (let i = 0; i < 384; i++) original[i] = (i - 192) / 192;
    const buf = embeddingToBuffer(original);
    expect(buf.length).toBe(1536); // 384 × 4

    const restored = bufferToEmbedding(buf);
    expect(restored!.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(restored![i]).toBeCloseTo(original[i], 5);
    }
  });

  test("bufferToEmbedding returns null for null/empty input", () => {
    expect(bufferToEmbedding(null)).toBeNull();
    expect(bufferToEmbedding(Buffer.alloc(0))).toBeNull();
  });

  test("bufferToEmbedding returns null for buffer with wrong byte length", () => {
    // 5 bytes — not divisible by 4
    expect(bufferToEmbedding(Buffer.from([1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([-1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("works on non-normalized vectors (length-irrelevant)", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([5, 0, 0, 0]); // 5× magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test("returns 0 for empty input", () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });

  test("returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("returns 0 for all-zero vector (avoids divide-by-zero)", () => {
    const a = new Float32Array([0, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("returns expected value for known similar vectors", () => {
    // Two vectors at 60° angle have cosine similarity 0.5
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.5, Math.sqrt(3) / 2]); // 60° rotation
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe("topK", () => {
  // Helper to build a candidate with given embedding
  const mk = (id: string, idx: number, text: string, vec: number[]) => ({
    chunkId: id,
    chunkIndex: idx,
    text,
    embedding: new Float32Array(vec),
  });

  test("returns top-K chunks sorted by score descending", () => {
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      mk("a", 0, "alpha", [0.1, 0, 0]),   // cos ~ 1.0
      mk("b", 1, "beta", [0, 1, 0]),      // cos = 0.0
      mk("c", 2, "gamma", [0.5, 0, 0]),   // cos ~ 1.0 (close to alpha)
      mk("d", 3, "delta", [-1, 0, 0]),    // cos = -1.0
    ];

    const results = topK(query, candidates, 2);
    expect(results).toHaveLength(2);
    expect(results[0].chunkId).toBe("a");
    expect(results[1].chunkId).toBe("c");
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  test("returns all candidates when K > number of embedded chunks", () => {
    const query = new Float32Array([1, 0]);
    const candidates = [
      mk("a", 0, "alpha", [1, 0]),
      mk("b", 1, "beta", [0, 1]),
    ];
    const results = topK(query, candidates, 5);
    expect(results).toHaveLength(2);
  });

  test("skips candidates with NULL embeddings", () => {
    const query = new Float32Array([1, 0]);
    const candidates = [
      mk("a", 0, "alpha", [1, 0]),
      { chunkId: "b", chunkIndex: 1, text: "beta", embedding: null },
      mk("c", 2, "gamma", [0.5, 0]),
    ];
    const results = topK(query, candidates, 3);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.chunkId === "b")).toBeUndefined();
  });

  test("returns empty array when all candidates have NULL embeddings", () => {
    const query = new Float32Array([1, 0]);
    const candidates = [
      { chunkId: "a", chunkIndex: 0, text: "alpha", embedding: null },
      { chunkId: "b", chunkIndex: 1, text: "beta", embedding: null },
    ];
    const results = topK(query, candidates, 3);
    expect(results).toEqual([]);
  });

  test("returns empty array for empty candidates", () => {
    const query = new Float32Array([1, 0]);
    const results = topK(query, [], 3);
    expect(results).toEqual([]);
  });

  test("preserves chunk metadata (text, index) in results", () => {
    const query = new Float32Array([1, 0]);
    const candidates = [
      mk("xyz", 7, "the chunk text", [1, 0]),
    ];
    const results = topK(query, candidates, 1);
    expect(results[0].chunkId).toBe("xyz");
    expect(results[0].chunkIndex).toBe(7);
    expect(results[0].text).toBe("the chunk text");
  });
});
