import ZAI from "z-ai-web-dev-sdk";

/**
 * Shared LLM helpers used by /api/chat, /api/youtube-summary, and
 * /api/youtube-interview.
 *
 * IMPORTANT — REAL STREAMING (fixes the 502 problem):
 * The previous version awaited the FULL completion before re-streaming the
 * text back to the client with a fake typing delay. That meant the proxy
 * between the user's browser and the dev server saw NO response bytes for
 * 60-90 seconds (the time it takes the LLM to generate a 15-question
 * interview), and the proxy returned 502 "Gateway Timeout" even though the
 * Next.js function eventually completed successfully.
 *
 * The fix: pipe the Z.ai SDK's streaming response directly to the HTTP
 * response, so the first token reaches the browser within ~1 second and
 * the proxy connection stays alive throughout the generation.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VisionMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

/** Configuration for the retry wrapper. */
const RETRY_CONFIG = {
  /** Maximum number of attempts (including the first one). */
  maxAttempts: 3,
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: 1200,
  /** Maximum delay between retries. */
  maxDelayMs: 6000,
};

/**
 * Classify an error as "transient" — i.e., one that's worth retrying.
 * We retry on:
 *   - HTTP 429 (rate limit — with backoff, the gateway recovers)
 *   - HTTP 502/503/504/520/521/522/524 (gateway/upstream errors)
 *   - Network errors (fetch failed, ECONNRESET, ETIMEDOUT, socket hang up)
 *   - AbortError (timeout)
 *
 * We do NOT retry on:
 *   - HTTP 400/401/403/422 (client errors — retrying won't help)
 */
function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (typeof status === "number") {
    return (
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      status === 520 ||
      status === 521 ||
      status === 522 ||
      status === 524
    );
  }
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout") ||
    msg.includes("upstream") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("terminated") ||
    msg.includes("aborted")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async function with retry-on-transient-error semantics.
 * Uses exponential backoff: delay = min(maxDelay, base * 2^(attempt-1)).
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = RETRY_CONFIG;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isTransientError(err)) {
        throw err;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      console.warn(
        `[llm] attempt ${attempt} failed (${(err as Error)?.message ?? err}); retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }
  // Should never reach here, but TS doesn't know that.
  throw lastErr;
}

/**
 * Create a ZAI client. We re-create per request because the SDK client is
 * lightweight and this avoids any accidental cross-request state.
 */
export async function getZai() {
  return await ZAI.create();
}

/**
 * Send a plain-text chat completion (non-streaming) with retry on transient
 * errors. Returns the assistant's full message content as a string.
 *
 * Use this when you need the FULL response before doing more work (e.g.
 * when you need to inspect it, post-process it, or wrap it in a header).
 * For pure chat replies, prefer chatCompleteStream() so the client sees
 * tokens immediately and the proxy doesn't time out.
 */
export async function chatComplete(
  messages: ChatMessage[]
): Promise<string> {
  const zai = await getZai();
  const completion = await withRetry(() =>
    zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
    })
  );
  return (
    completion?.choices?.[0]?.message?.content ??
    "Sorry, I couldn't generate a response. Please try again."
  );
}

/**
 * Send a vision (multimodal) chat completion (non-streaming) with retry.
 * Used by /api/chat when the latest user message has image attachments.
 */
export async function visionComplete(
  messages: VisionMessage[],
  model = "glm-4v-flash"
): Promise<string> {
  const zai = await getZai();
  const completion = await withRetry(() =>
    zai.chat.completions.createVision({
      model,
      messages,
      thinking: { type: "disabled" },
    } as any)
  );
  return (
    completion?.choices?.[0]?.message?.content ??
    "Sorry, I couldn't analyze the attached image(s). Please try again."
  );
}

/**
 * Parse one SSE chunk (Uint8Array or string) and return any new content
 * deltas found in it. The Z.ai SDK yields raw SSE bytes when `stream: true`
 * is set; each line looks like `data: {"choices":[{"delta":{"content":"..."}}]}`
 * or `data: [DONE]`.
 *
 * The parser is tolerant of partial chunks (a JSON object split across
 * multiple Uint8Array yields) by buffering incomplete lines.
 */
class SSEParser {
  private buffer = "";

  feed(chunk: Uint8Array | string): string[] {
    const text =
      typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk, { stream: true });
    this.buffer += text;

    const out: string[] = [];
    const lines = this.buffer.split("\n");
    // Keep the last (possibly partial) line in the buffer for next feed().
    this.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          out.push(delta);
        }
      } catch {
        // Partial JSON across chunks — ignore; will be completed next feed()
      }
    }
    return out;
  }

  /** Flush any remaining buffer content. Usually a no-op. */
  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const leftover = this.buffer;
    this.buffer = "";
    return this.feed(leftover);
  }
}

/**
 * Streaming version of chatComplete. Returns a ReadableStream that yields
 * the assistant's response token-by-token AS THE LLM PRODUCES IT, with no
 * artificial delay. This is critical for avoiding proxy 502 timeouts on
 * long generations (15-question interview Q&A can take 60+ seconds to
 * complete non-streaming, but the first token arrives in ~1s when
 * streaming).
 *
 * The retry logic wraps the initial SDK call — once the stream has started,
 * mid-stream failures are not retried (would duplicate partial output).
 */
export async function chatCompleteStream(
  messages: ChatMessage[]
): Promise<ReadableStream<Uint8Array>> {
  const zai = await getZai();
  const stream = await withRetry(() =>
    zai.chat.completions.create({
      messages,
      stream: true,
      thinking: { type: "disabled" },
    })
  );

  const encoder = new TextEncoder();
  const parser = new SSEParser();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const deltas = parser.feed(chunk as Uint8Array);
          for (const d of deltas) {
            controller.enqueue(encoder.encode(d));
          }
        }
        // Flush any trailing content
        for (const d of parser.flush()) {
          controller.enqueue(encoder.encode(d));
        }
      } catch (err) {
        // Mid-stream error — emit a notice and close. We can't retry here
        // without duplicating what we've already sent.
        const msg = err instanceof Error ? err.message : "Stream interrupted";
        console.error("[llm] mid-stream error:", msg);
        controller.enqueue(
          encoder.encode(`\n\n⚠️ _Stream interrupted: ${msg}_`)
        );
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Streaming version of visionComplete — same pattern as chatCompleteStream
 * but for the vision endpoint.
 */
export async function visionCompleteStream(
  messages: VisionMessage[],
  model = "glm-4v-flash"
): Promise<ReadableStream<Uint8Array>> {
  const zai = await getZai();
  const stream = await withRetry(() =>
    zai.chat.completions.createVision({
      model,
      messages,
      stream: true,
      thinking: { type: "disabled" },
    } as any)
  );

  const encoder = new TextEncoder();
  const parser = new SSEParser();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const deltas = parser.feed(chunk as Uint8Array);
          for (const d of deltas) {
            controller.enqueue(encoder.encode(d));
          }
        }
        for (const d of parser.flush()) {
          controller.enqueue(encoder.encode(d));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream interrupted";
        console.error("[llm vision] mid-stream error:", msg);
        controller.enqueue(
          encoder.encode(`\n\n⚠️ _Stream interrupted: ${msg}_`)
        );
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Build a streaming ReadableStream that emits `header` first (fast, 4ms per
 * token) then `content` (12ms per token). This is the FAKE typing stream —
 * used when content is already fully in hand (e.g. the YouTube routes that
 * need to inject a header before the LLM output). For pure chat, prefer
 * chatCompleteStream() which pipes real LLM tokens.
 */
export function streamTextResponse(
  header: string,
  content: string
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const tok of header.match(/\s+|\S+/g) ?? [header]) {
        controller.enqueue(encoder.encode(tok));
        await new Promise((r) => setTimeout(r, 4));
      }
      const tokens = content.match(/\s+|\S+/g) ?? [content];
      for (const token of tokens) {
        controller.enqueue(encoder.encode(token));
        await new Promise((r) => setTimeout(r, 12));
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
}

/**
 * Build a streaming Response that emits a static `header` first, then PIPES
 * the LLM stream directly so the client receives tokens as they're
 * generated. Used by the YouTube routes — the header is written quickly
 * (4ms per token) so it appears immediately, then the LLM stream takes
 * over with no artificial delay.
 *
 * This is the proper fix for proxy 502 timeouts on long generations.
 */
export function streamHeaderAndLLM(
  header: string,
  llmStream: ReadableStream<Uint8Array>
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Phase 1: emit the header quickly so the client sees immediate output
      // (this also keeps the proxy connection alive).
      for (const tok of header.match(/\s+|\S+/g) ?? [header]) {
        controller.enqueue(encoder.encode(tok));
      }
      // Phase 2: pipe the LLM stream through.
      const reader = llmStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        controller.enqueue(
          encoder.encode(`\n\n⚠️ _Stream error: ${msg}_`)
        );
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
