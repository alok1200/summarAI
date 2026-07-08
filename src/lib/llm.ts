import { GoogleGenAI } from '@google/genai';

/**
 * Shared LLM helpers used by /api/chat, /api/youtube-summary, and
 * /api/youtube-interview.
 *
 * BACKEND: Google Gemini only (via @google/genai SDK).
 *
 * The public API of this module (function names, signatures, and the
 * ChatMessage / VisionMessage interfaces) is intentionally preserved from
 * previous versions, so the four API routes that import from here (chat,
 * youtube-summary, youtube-interview, youtube-load) do not need to change.
 *
 * IMPORTANT — REAL STREAMING (fixes the 502 problem):
 * chatCompleteStream() and visionCompleteStream() pipe Gemini's
 * generateContentStream() chunks directly to the HTTP response, so the
 * first token reaches the browser within ~1 second and the proxy
 * connection stays alive throughout the generation.
 *
 * ENV VARS:
 *   GEMINI_API_KEY   (required) — get one at https://aistudio.google.com/apikey
 *   LLM_MODEL        (optional) — override the chat model (default: gemini-2.0-flash)
 *   LLM_VISION_MODEL (optional) — override the vision model (default: gemini-2.0-flash)
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VisionMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
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
 *
 * Exported so the retry policy can be unit-tested directly.
 */
export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (typeof status === 'number') {
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
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('upstream') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('aborted')
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
      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1),
      );
      console.warn(
        `[llm] attempt ${attempt} failed (${(err as Error)?.message ?? err}); retrying in ${delay}ms…`,
      );
      await sleep(delay);
    }
  }
  // Should never reach here, but TS doesn't know that.
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

/**
 * Default Gemini models. Both text and vision default to gemini-2.0-flash
 * because it is fast, cheap, multimodal (text + vision in the same model),
 * and universally available on every Gemini API key.
 *
 * Override with the LLM_MODEL / LLM_VISION_MODEL env vars if you want to
 * use a different model (e.g. gemini-2.5-pro for higher-quality output,
 * gemini-2.0-flash-lite for cheaper runs).
 */
const DEFAULT_CHAT_MODEL = 'gemini-2.0-flash';
const DEFAULT_VISION_MODEL = 'gemini-2.0-flash';

let cachedClient: GoogleGenAI | null = null;

/**
 * Get a cached GoogleGenAI client. Requires GEMINI_API_KEY in the env.
 *
 * Throws a helpful, actionable error if the key is missing (rather than
 * a cryptic SDK error) so the user knows exactly what to do.
 */
function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey ' +
        'and add it to your .env file as GEMINI_API_KEY="your-key-here".',
    );
  }
  cachedClient = new GoogleGenAI({ apiKey: apiKey.trim() });
  return cachedClient;
}

/**
 * Resolve the chat model name. If LLM_MODEL is set in the environment, use it;
 * otherwise return undefined, and callers fall back to DEFAULT_CHAT_MODEL.
 *
 * (Preserved as `string | undefined` from previous versions so existing
 * unit tests that expect undefined keep passing.)
 */
export function getLLMModel(): string | undefined {
  const m = process.env.LLM_MODEL;
  return m && m.trim() !== '' ? m.trim() : undefined;
}

/**
 * Resolve the vision model name. Defaults to gemini-2.0-flash if
 * LLM_VISION_MODEL is unset/empty (Gemini 2.0 Flash supports vision natively,
 * so a separate vision model is not needed).
 */
export function getLLMVisionModel(): string {
  const m = process.env.LLM_VISION_MODEL;
  return m && m.trim() !== '' ? m.trim() : DEFAULT_VISION_MODEL;
}

// ---------------------------------------------------------------------------
// Message format conversion (OpenAI-style → Gemini-style)
// ---------------------------------------------------------------------------

/**
 * Gemini uses `role: "user" | "model"` (not "assistant") and separates the
 * system prompt into `config.systemInstruction` rather than the contents array.
 *
 * This function converts our internal ChatMessage[] into the shape Gemini's
 * SDK expects, returning `{ contents, systemInstruction }`.
 */
function toGeminiContents(messages: ChatMessage[]): {
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  systemInstruction?: string;
} {
  const systemParts: string[] = [];
  const contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  return {
    contents,
    systemInstruction:
      systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

/**
 * Parse a data URL (e.g. "data:image/png;base64,iVBOR...") into the
 * mimeType + base64 data that Gemini's inlineData part expects.
 *
 * Returns null if the input isn't a recognisable data URL.
 */
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  // Match: data:<mime>;base64,<data>  (without the /s flag so we don't need es2018+)
  const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Convert our VisionMessage[] (OpenAI-style multimodal format) into Gemini's
 * `contents` shape. Image parts become `{ inlineData: { mimeType, data } }`.
 *
 * System messages are extracted into `systemInstruction` (same as the text
 * path), since Gemini doesn't allow a system role inside `contents`.
 */
function toGeminiVisionContents(messages: VisionMessage[]): {
  contents: Array<{
    role: 'user' | 'model';
    parts: Array<{
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }>;
  }>;
  systemInstruction?: string;
} {
  const systemParts: string[] = [];
  const contents: Array<{
    role: 'user' | 'model';
    parts: Array<{
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }>;
  }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      continue;
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    // Array form: convert each part to Gemini's Part shape.
    const parts: Array<{
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }> = [];
    for (const p of m.content) {
      if (p.type === 'text' && typeof p.text === 'string') {
        parts.push({ text: p.text });
      } else if (p.type === 'image_url' && p.image_url?.url) {
        const parsed = parseDataUrl(p.image_url.url);
        if (parsed) {
          parts.push({ inlineData: parsed });
        }
      }
    }
    if (parts.length === 0) {
      // Defensive: never send an empty parts array — Gemini rejects it.
      parts.push({ text: '' });
    }
    contents.push({ role, parts });
  }
  return {
    contents,
    systemInstruction:
      systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API — non-streaming completions
// ---------------------------------------------------------------------------

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
  messages: ChatMessage[],
  options?: { maxTokens?: number },
): Promise<string> {
  const client = getClient();
  const { contents, systemInstruction } = toGeminiContents(messages);
  const response = await withRetry(() =>
    client.models.generateContent({
      model: getLLMModel() ?? DEFAULT_CHAT_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      },
    }),
  );
  const text = response.text;
  return text ?? "Sorry, I couldn't generate a response. Please try again.";
}

/**
 * Send a vision (multimodal) chat completion (non-streaming) with retry.
 * Used by /api/chat when the latest user message has image attachments.
 */
export async function visionComplete(
  messages: VisionMessage[],
  model: string = getLLMVisionModel(),
): Promise<string> {
  const client = getClient();
  const { contents, systemInstruction } = toGeminiVisionContents(messages);
  const response = await withRetry(() =>
    client.models.generateContent({
      model,
      contents,
      config: systemInstruction ? { systemInstruction } : {},
    }),
  );
  const text = response.text;
  return (
    text ?? "Sorry, I couldn't analyze the attached image(s). Please try again."
  );
}

// ---------------------------------------------------------------------------
// Public API — streaming completions
// ---------------------------------------------------------------------------

/**
 * Parse one SSE chunk (Uint8Array or string) and return any new content
 * deltas found in it.
 *
 * NOTE: This class is not used by the streaming code paths below (the
 * @google/genai SDK yields structured chunks with a `.text` property, not
 * raw SSE bytes). It is kept for backwards compatibility with existing unit
 * tests and any future code that might want to parse SSE.
 */
export class SSEParser {
  private buffer = '';

  feed(chunk: Uint8Array | string): string[] {
    const text =
      typeof chunk === 'string'
        ? chunk
        : new TextDecoder().decode(chunk, { stream: true });
    this.buffer += text;

    const out: string[] = [];
    const lines = this.buffer.split('\n');
    // Keep the last (possibly partial) line in the buffer for next feed().
    this.buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          out.push(delta);
        }
      } catch {
        // Partial JSON across chunks — ignore; will be completed next feed()
      }
    }
    return out;
  }

  /**
   * Flush any remaining buffer content. Usually a no-op when the stream
   * ended with a trailing newline, but if the SDK's stream ends mid-line
   * (no trailing `\n`), the buffer holds a complete `data:` payload that
   * `feed()` would otherwise just re-buffer forever. We append a newline
   * so feed() treats the buffered content as a complete line and parses it.
   */
  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const leftover = this.buffer;
    this.buffer = '';
    return this.feed(leftover + '\n');
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
  messages: ChatMessage[],
  options?: { maxTokens?: number },
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const client = getClient();
  const { contents, systemInstruction } = toGeminiContents(messages);
  const stream = await withRetry(() =>
    client.models.generateContentStream({
      model: getLLMModel() ?? DEFAULT_CHAT_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      },
    }),
  );

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const text = typeof chunk?.text === 'string' ? chunk.text : '';
          if (text.length > 0) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (err) {
        // Mid-stream error — emit a notice and close. We can't retry here
        // without duplicating what we've already sent.
        const msg = err instanceof Error ? err.message : 'Stream interrupted';
        console.error('[llm] mid-stream error:', msg);
        controller.enqueue(
          encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`),
        );
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Streaming version of visionComplete — same pattern as chatCompleteStream
 * but for multimodal input (text + images).
 */
export async function visionCompleteStream(
  messages: VisionMessage[],
  model: string = getLLMVisionModel(),
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const client = getClient();
  const { contents, systemInstruction } = toGeminiVisionContents(messages);
  const stream = await withRetry(() =>
    client.models.generateContentStream({
      model,
      contents,
      config: systemInstruction ? { systemInstruction } : {},
    }),
  );

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const text = typeof chunk?.text === 'string' ? chunk.text : '';
          if (text.length > 0) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream interrupted';
        console.error('[llm vision] mid-stream error:', msg);
        controller.enqueue(
          encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`),
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
export function streamTextResponse(header: string, content: string): Response {
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
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
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
  llmStream: ReadableStream<Uint8Array>,
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
        const msg = err instanceof Error ? err.message : 'Stream error';
        controller.enqueue(encoder.encode(`\n\n⚠️ _Stream error: ${msg}_`));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
