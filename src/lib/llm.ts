import ZAI from "z-ai-web-dev-sdk";

/**
 * Shared LLM helpers used by /api/chat, /api/youtube-summary, and
 * /api/youtube-interview. Centralizing the call here lets us apply retry
 * logic and consistent error handling for transient gateway failures
 * (502/503/504/timeout) — the kind of errors that previously surfaced to
 * users as "⚠️ Error: Request failed: 502" with no recovery.
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
 *   - HTTP 502/503/504/520/521/522/524 (gateway/upstream errors)
 *   - Network errors (fetch failed, ECONNRESET, ETIMEDOUT, socket hang up)
 *   - AbortError (timeout)
 *
 * We do NOT retry on:
 *   - HTTP 400/401/403/422 (client errors — retrying won't help)
 *   - HTTP 429 (rate limit — the SDK should back off, and we don't want to
 *     make it worse by hammering the gateway)
 */
function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (typeof status === "number") {
    return (
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
 * Send a plain-text chat completion with retry on transient errors.
 * Returns the assistant's message content (string).
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
 * Send a vision (multimodal) chat completion with retry on transient errors.
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
 * Build a streaming ReadableStream that emits `header` first (fast, 4ms per
 * token) then `content` (12ms per token). This gives the chat UI a typing
 * effect. Used by the YouTube routes.
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
