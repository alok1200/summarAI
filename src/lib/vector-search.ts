/**
 * Cosine similarity search over transcript chunks.
 *
 * Given a query embedding and a list of chunk embeddings, find the top-K
 * most similar chunks. Used by /api/chat to retrieve relevant context
 * from long-video transcripts.
 *
 * ALGORITHM: brute-force cosine similarity. For each chunk, compute:
 *
 *     similarity = dot(query, chunk) / (‖query‖ × ‖chunk‖)
 *
 * Since the embedding model normalizes vectors to unit length, ‖query‖ and
 * ‖chunk‖ are both ≈1, so similarity ≈ dot product — a single SIMD-friendly
 * multiply-add loop.
 *
 * PERFORMANCE: brute-force is fine for our scale.
 *   - 1 long video → ~10-30 chunks → ~30 dot products → <1ms
 *   - 100 long videos → ~3000 chunks → ~3000 dot products → <10ms
 *   - For >100k chunks, switch to an ANN index (HNSW, sqlite-vec, etc.)
 *
 * The embeddings are normalized at generation time (embeddings.ts sets
 * `normalize: true`), but we re-normalize defensively here in case any
 * embedding was stored before normalization was added or got corrupted.
 */

import { db } from "@/lib/db";
import { bufferToEmbedding } from "@/lib/embeddings";
import { logger } from "@/lib/logger";

export interface VectorSearchResult {
  /** Chunk ID (Prisma cuid) */
  chunkId: string;
  /** 0-indexed position within the transcript */
  chunkIndex: number;
  /** The full text of the chunk */
  text: string;
  /** Cosine similarity score ∈ [-1, 1]. Higher = more similar. */
  score: number;
}

/**
 * Compute cosine similarity between two (possibly unnormalized) vectors.
 *
 * Returns 0 if either vector is empty or all-zeros (avoiding divide-by-zero).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Find the top-K most similar chunks to the query embedding.
 *
 * This is a pure function — given the candidate list + query, returns the
 * top-K results. Used by `retrieveRelevantChunks` after we've loaded the
 * chunks from the DB.
 *
 * Chunks with NULL embeddings (e.g., embedding generation failed) are
 * silently skipped.
 */
export function topK(
  query: Float32Array,
  candidates: Array<{ chunkId: string; chunkIndex: number; text: string; embedding: Float32Array | null }>,
  k: number
): VectorSearchResult[] {
  const scored: VectorSearchResult[] = [];

  for (const c of candidates) {
    if (!c.embedding) continue;
    const score = cosineSimilarity(query, c.embedding);
    scored.push({
      chunkId: c.chunkId,
      chunkIndex: c.chunkIndex,
      text: c.text,
      score,
    });
  }

  // Sort by score descending, take top K.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Load all chunks for a transcript from the DB and deserialize their
 * embeddings. Chunks are returned in chunkIndex order.
 *
 * If the transcript doesn't exist or has no chunks, returns an empty array.
 * Caller should handle this (e.g., fall back to LLM-as-retriever).
 */
export async function loadTranscriptChunks(
  transcriptId: string
): Promise<Array<{ chunkId: string; chunkIndex: number; text: string; embedding: Float32Array | null }>> {
  const rows = await db.transcriptChunk.findMany({
    where: { transcriptId },
    orderBy: { chunkIndex: "asc" },
    select: {
      id: true,
      chunkIndex: true,
      text: true,
      embedding: true,
    },
  });

  return rows.map((r) => ({
    chunkId: r.id,
    chunkIndex: r.chunkIndex,
    text: r.text,
    embedding: bufferToEmbedding(r.embedding),
  }));
}

/**
 * High-level: retrieve the top-K chunks most relevant to a user's question.
 *
 * Flow:
 *   1. Load all chunks for the transcript from the DB.
 *   2. Run cosine similarity against the query embedding.
 *   3. Return the top-K chunks (with their scores).
 *
 * If the transcript has fewer than K embedded chunks, returns whatever is
 * available. If it has zero embedded chunks, returns an empty array —
 * caller should fall back to LLM-as-retriever.
 *
 * @param transcriptId  The transcript to search within
 * @param queryEmbedding  The embedded user question (384-dim)
 * @param k  Number of chunks to retrieve (default 3)
 */
export async function retrieveRelevantChunks(
  transcriptId: string,
  queryEmbedding: Float32Array,
  k: number = 3
): Promise<VectorSearchResult[]> {
  const chunks = await loadTranscriptChunks(transcriptId);

  // If no chunks are embedded, vector search can't work — return empty
  // and let the caller fall back to LLM-as-retriever.
  const embeddedCount = chunks.filter((c) => c.embedding !== null).length;
  if (embeddedCount === 0) {
    logger.warn("vector_search.no_embeddings", { transcriptId, chunkCount: chunks.length });
    return [];
  }

  const results = topK(queryEmbedding, chunks, k);

  logger.info("vector_search.complete", {
    transcriptId,
    embeddedChunks: embeddedCount,
    totalChunks: chunks.length,
    topScore: results[0]?.score ?? 0,
    returned: results.length,
  });

  return results;
}
