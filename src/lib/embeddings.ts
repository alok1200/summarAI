/**
 * Local embedding generation via Transformers.js.
 *
 * Uses Xenova/all-MiniLM-L6-v2 — a small (23M params), fast, 384-dim
 * sentence embedding model. On first use, the model is downloaded from
 * HuggingFace (~25MB) and cached on disk for subsequent runs.
 *
 * WHY LOCAL (not OpenAI/ZAI):
 *   - No API key needed
 *   - No per-call cost
 *   - Works offline after first download
 *   - 384-dim keeps DB storage small (1.5 KB per chunk)
 *   - Embeds in ~50-150ms per chunk on commodity hardware
 *
 * MODEL CHOICE:
 *   all-MiniLM-L6-v2 is the standard small embedding model. It scores
 *   ~56 on the STS benchmark (vs. ~62 for OpenAI text-embedding-3-small)
 *   — close enough for chat retrieval, where we just need to find the
 *   roughly-right chunks, not make fine-grained relevance distinctions.
 *
 * LIFECYCLE:
 *   - The pipeline is lazy-loaded on first use (so the dev server starts
 *     fast and we don't pay the ~25MB download cost until someone actually
 *     loads a video).
 *   - Once loaded, the pipeline is cached module-level so subsequent calls
 *     reuse it (no reload per request).
 *
 * ERROR HANDLING:
 *   - Network errors during model download → caller falls back to
 *     LLM-as-retriever (see /api/chat/route.ts)
 *   - Embedding individual chunk fails → that chunk's embedding stays
 *     NULL in the DB; vector search skips it
 */

import { logger } from "@/lib/logger";

// Lazy-loaded pipeline — undefined until first use.
let pipelinePromise: Promise<Pipeline> | null = null;

// Type-only import to avoid pulling the full Transformers.js bundle into
// the type checker's view (the actual import is dynamic, below).
type Pipeline = Awaited<
  ReturnType<
    typeof import("@xenova/transformers")["pipeline"]
  >
>;

/**
 * The dimensionality of the embedding vectors produced by the model.
 * all-MiniLM-L6-v2 → 384.
 *
 * Exported so vector-search.ts and the Prisma schema can reference the
 * same constant for validation.
 */
export const EMBEDDING_DIM = 384;

/**
 * Get (or lazy-load) the embedding pipeline.
 *
 * The first call triggers the dynamic import of Transformers.js + the
 * model download. Subsequent calls return the cached promise.
 */
async function getPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");

      // Allow remote download on first use, then cache locally.
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      logger.info("embeddings.model.loading", {
        model: "Xenova/all-MiniLM-L6-v2",
      });

      const pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { quantized: true } // 8-bit quantized → ~25MB instead of ~90MB
      );

      logger.info("embeddings.model.loaded", {
        model: "Xenova/all-MiniLM-L6-v2",
      });

      return pipe;
    })();
  }
  return pipelinePromise;
}

/**
 * Embed a single text string into a 384-dim Float32Array.
 *
 * The pipeline returns a 2D tensor; we apply mean pooling across tokens
 * (the standard way to get a single sentence embedding from MiniLM).
 *
 * Returns null if embedding fails — callers should handle this gracefully
 * (e.g., skip vector search and fall back to LLM-as-retriever).
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!text || !text.trim()) return null;
  try {
    const pipe = await getPipeline();

    // The transformers.js pipeline function has extremely complex overload
    // types that TypeScript can't satisfy with simple object literals.
    // Cast to a minimal callable shape and access the result via `any` —
    // we validate the result shape at runtime below.
    type AnyPipeline = (text: string, options: Record<string, unknown>) =>
      Promise<{ data: Float32Array | number[] | { [k: number]: number } }>;
    const callable = pipe as unknown as AnyPipeline;

    const output = await callable(text, {
      pooling: "mean",
      normalize: true,
    });

    // The output.data may be a Float32Array, a plain number[], or a
    // TypedArray-like object — normalize to Float32Array.
    const data = output.data;
    if (data instanceof Float32Array) {
      return data;
    }
    if (Array.isArray(data)) {
      return new Float32Array(data);
    }
    // Object with numeric indices (some transformers.js versions)
    return new Float32Array(Array.from(data as ArrayLike<number>));
  } catch (err) {
    logger.error("embeddings.embed_text.error", {
      error: err instanceof Error ? err.message : String(err),
      textLength: text.length,
    });
    return null;
  }
}

/**
 * Embed multiple texts in a single batch — more efficient than calling
 * embedText() in a loop because the pipeline is reused and inference
 * can be parallelized internally.
 *
 * Returns an array aligned with the input (null for any text that failed
 * to embed). Callers can check `results[i] === null` to know which
 * chunks need retry / fallback.
 *
 * Concurrency: processed in chunks of 8 to bound memory usage. Each
 * batch waits for all 8 embeddings to complete before starting the next.
 */
export async function embedBatch(
  texts: string[]
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];

  const BATCH_SIZE = 8;
  const results: (Float32Array | null)[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((t) => embedText(t)));
    results.push(...batchResults);
  }

  return results;
}

/**
 * Serialize a Float32Array embedding into a Uint8Array for Prisma BLOB storage.
 *
 * Format: raw Float32Array.buffer bytes (1536 bytes for 384 floats).
 *
 * Returns Uint8Array<ArrayBuffer> for Prisma compatibility — Prisma's
 * Bytes field rejects SharedArrayBuffer-backed typed arrays.
 */
export function embeddingToBuffer(embedding: Float32Array): Uint8Array<ArrayBuffer> {
  // Copy into a fresh ArrayBuffer to guarantee it's a real ArrayBuffer,
  // not a SharedArrayBuffer (which Prisma's types reject).
  const ab = new ArrayBuffer(embedding.byteLength);
  const view = new Uint8Array(ab);
  view.set(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  return view;
}

/**
 * Deserialize a Uint8Array/Buffer from Prisma BLOB back into a Float32Array.
 *
 * Returns null if the buffer is empty or the wrong length.
 */
export function bufferToEmbedding(buf: Uint8Array | Buffer | null): Float32Array | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length % 4 !== 0) return null;
  // Copy into a new ArrayBuffer to avoid SharedArrayBuffer issues.
  const arrayBuffer = new ArrayBuffer(buf.length);
  new Uint8Array(arrayBuffer).set(buf);
  return new Float32Array(arrayBuffer);
}
