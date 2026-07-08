import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import ZAISDK from "z-ai-web-dev-sdk";

/**
 * Shared LLM helpers used by /api/chat, /api/youtube-summary, and
 * /api/youtube-interview.
 *
 * BACKEND: Google Gemini (via @google/genai SDK).
 *
 * The public API of this module (function names, signatures, and the
 * ChatMessage / VisionMessage interfaces) is intentionally preserved
 * from the previous Z.AI-backed version, so the four API routes that
 * import from here (chat, youtube-summary, youtube-interview,
 * youtube-load) do not need to change.
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
 *
 * Exported so the retry policy can be unit-tested directly.
 */
export function isTransientError(err: unknown): boolean {
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
const DEFAULT_CHAT_MODEL = "gemini-2.0-flash";
const DEFAULT_VISION_MODEL = "gemini-2.0-flash";

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
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it to your .env file as GEMINI_API_KEY=\"your-key-here\"."
    );
  }
  cachedClient = new GoogleGenAI({ apiKey: apiKey.trim() });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// DeepSeek fallback (OpenAI-compatible API)
// ---------------------------------------------------------------------------
//
// Real Gemini API keys start with "AIza". If the GEMINI_API_KEY in the env
// does NOT start with "AIza" (e.g. it's a DeepSeek key with format
// "hex.alphanumeric"), we transparently route chat/vision calls through
// DeepSeek's OpenAI-compatible API at https://api.deepseek.com/v1 instead.
//
// This lets users drop a DeepSeek key into GEMINI_API_KEY and still have a
// working app, even though the variable name says "GEMINI". The DEEPSEEK_API_KEY
// and DEEPSEEK_BASE_URL env vars are also recognised as explicit overrides.
//
// All DeepSeek calls use the `deepseek-chat` model by default (override with
// LLM_MODEL). Vision input is silently downgraded to text-only on DeepSeek
// (the image parts are dropped with a warning log).

/**
 * Returns true if the configured GEMINI_API_KEY looks like a real Gemini key
 * (starts with "AIza" and is at least 30 chars). Returns false if it's missing
 * or has a different format (likely a DeepSeek key).
 */
function isGeminiKeyConfigured(): boolean {
  const k = process.env.GEMINI_API_KEY?.trim() ?? "";
  return k.startsWith("AIza") && k.length >= 30;
}

/**
 * Returns true if any DeepSeek-compatible key is configured — either via
 * DEEPSEEK_API_KEY, or via a GEMINI_API_KEY that doesn't look like a real
 * Gemini key (so we assume it's a DeepSeek key).
 */
function isDeepSeekKeyConfigured(): boolean {
  const explicit = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (explicit.length > 0) return true;
  const gemini = process.env.GEMINI_API_KEY?.trim() ?? "";
  // Non-empty GEMINI_API_KEY that isn't a real Gemini key → treat as DeepSeek
  return gemini.length > 0 && !isGeminiKeyConfigured();
}

/**
 * Returns true if the DeepSeek key (explicit OR falling back from GEMINI_API_KEY)
 * has actually been verified to work. We start by assuming it works, then flip
 * this to false on the first 401 from DeepSeek's API so subsequent requests
 * skip straight to the Z.ai GLM fallback.
 */
let deepSeekVerifiedWorking: boolean | null = null;

let cachedDeepSeekClient: OpenAI | null = null;

/**
 * Get a cached OpenAI SDK client pointed at DeepSeek's API. Uses
 * DEEPSEEK_API_KEY if set, otherwise falls back to GEMINI_API_KEY (treating
 * it as a DeepSeek key when it doesn't start with "AIza").
 */
function getDeepSeekClient(): OpenAI {
  if (cachedDeepSeekClient) return cachedDeepSeekClient;
  const explicit = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  const fallback = process.env.GEMINI_API_KEY?.trim() ?? "";
  const apiKey = explicit || fallback;
  if (!apiKey) {
    throw new Error(
      "No LLM API key configured. Set either GEMINI_API_KEY (real Gemini key " +
        "starting with 'AIza') or DEEPSEEK_API_KEY in your .env file."
    );
  }
  cachedDeepSeekClient = new OpenAI({
    apiKey,
    baseURL:
      process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1",
  });
  return cachedDeepSeekClient;
}

// ---------------------------------------------------------------------------
// Z.ai GLM fallback (works out-of-the-box in this environment via the
// pre-installed /etc/.z-ai-config — no env vars needed).
// ---------------------------------------------------------------------------
//
// If both Gemini and DeepSeek are unavailable (missing/invalid keys), we fall
// back to Z.ai's GLM-4 model via the z-ai-web-dev-sdk package. The SDK reads
// its config from /etc/.z-ai-config (pre-provisioned in this sandbox).

let cachedZaiClient: any = null;
async function getZaiClient(): Promise<any> {
  if (cachedZaiClient) return cachedZaiClient;
  // ZAISDK.create() reads /etc/.z-ai-config (or ./.z-ai-config) and returns
  // a client whose `.chat.completions.create()` API is OpenAI-compatible.
  cachedZaiClient = await (ZAISDK as any).create();
  return cachedZaiClient;
}

/**
 * Decide which provider to use for THIS process. The provider is chosen
 * dynamically per-request: we try Gemini first (if a real Gemini key is set),
 * then DeepSeek (if a DeepSeek key is set AND hasn't failed authentication),
 * then fall back to Z.ai GLM (always available in this sandbox).
 *
 * The DeepSeek "verifiedWorking" flag is set to false on the first 401 from
 * DeepSeek, so subsequent requests skip the DeepSeek attempt entirely.
 */
async function getProvider(): Promise<"gemini" | "deepseek" | "zai"> {
  if (isGeminiKeyConfigured()) return "gemini";
  if (isDeepSeekKeyConfigured() && deepSeekVerifiedWorking !== false) {
    return "deepseek";
  }
  return "zai";
}

/**
 * Convert our internal ChatMessage[] into the OpenAI-style messages array
 * that DeepSeek's API expects. System messages are passed through as-is
 * (DeepSeek supports a system role, unlike Gemini).
 */
function toOpenAIMessages(
  messages: ChatMessage[]
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Resolve the chat model name. If LLM_MODEL is set in the environment, use it;
 * otherwise return undefined, and callers fall back to DEFAULT_CHAT_MODEL.
 *
 * (Preserved as `string | undefined` from the previous version so existing
 * unit tests that expect undefined keep passing.)
 */
export function getLLMModel(): string | undefined {
  const m = process.env.LLM_MODEL;
  return m && m.trim() !== "" ? m.trim() : undefined;
}

/**
 * Resolve the vision model name. Defaults to gemini-2.0-flash if
 * LLM_VISION_MODEL is unset/empty (Gemini 2.0 Flash supports vision natively,
 * so a separate vision model is not needed).
 */
export function getLLMVisionModel(): string {
  const m = process.env.LLM_VISION_MODEL;
  return m && m.trim() !== "" ? m.trim() : DEFAULT_VISION_MODEL;
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
function toGeminiContents(
  messages: ChatMessage[]
): {
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  systemInstruction?: string;
} {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  return {
    contents,
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
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
function toGeminiVisionContents(
  messages: VisionMessage[]
): {
  contents: Array<{
    role: "user" | "model";
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  systemInstruction?: string;
} {
  const systemParts: string[] = [];
  const contents: Array<{
    role: "user" | "model";
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    // Array form: convert each part to Gemini's Part shape.
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    for (const p of m.content) {
      if (p.type === "text" && typeof p.text === "string") {
        parts.push({ text: p.text });
      } else if (p.type === "image_url" && p.image_url?.url) {
        const parsed = parseDataUrl(p.image_url.url);
        if (parsed) {
          parts.push({ inlineData: parsed });
        }
      }
    }
    if (parts.length === 0) {
      // Defensive: never send an empty parts array — Gemini rejects it.
      parts.push({ text: "" });
    }
    contents.push({ role, parts });
  }
  return {
    contents,
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
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
  options?: { maxTokens?: number }
): Promise<string> {
  const provider = await getProvider();

  // Z.ai GLM branch — final fallback, always available in this sandbox
  if (provider === "zai") {
    const zai = await getZaiClient();
    const completion = await withRetry(() =>
      zai.chat.completions.create({
        messages: toOpenAIMessages(messages),
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      })
    );
    return (
      completion?.choices?.[0]?.message?.content ??
      "Sorry, I couldn't generate a response. Please try again."
    );
  }

  // DeepSeek branch — used when GEMINI_API_KEY doesn't look like a real
  // Gemini key (so we treat it as a DeepSeek key instead).
  if (provider === "deepseek") {
    try {
      const ds = getDeepSeekClient();
      const completion = await withRetry(() =>
        ds.chat.completions.create({
          model: getLLMModel() ?? "deepseek-chat",
          messages: toOpenAIMessages(messages),
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        })
      );
      deepSeekVerifiedWorking = true;
      return (
        completion.choices?.[0]?.message?.content ??
        "Sorry, I couldn't generate a response. Please try again."
      );
    } catch (err: any) {
      if (err?.status === 401 || /401|authentication/i.test(err?.message ?? "")) {
        console.warn("[llm] DeepSeek key rejected (401). Marking DeepSeek as broken; falling back to Z.ai GLM for this and future requests.");
        deepSeekVerifiedWorking = false;
        // Fall through to Z.ai by re-cursing once (provider will now be "zai")
        return chatComplete(messages, options);
      }
      throw err;
    }
  }

  // Gemini branch (default)
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
    })
  );
  const text = response.text;
  return (
    text ??
    "Sorry, I couldn't generate a response. Please try again."
  );
}

/**
 * Send a vision (multimodal) chat completion (non-streaming) with retry.
 * Used by /api/chat when the latest user message has image attachments.
 */
export async function visionComplete(
  messages: VisionMessage[],
  model: string = getLLMVisionModel()
): Promise<string> {
  const provider = await getProvider();

  // Z.ai GLM branch — Z.ai supports vision via z-ai-web-dev-sdk's createVision
  if (provider === "zai") {
    const zai = await getZaiClient();
    // Convert our VisionMessage[] → Z.ai vision format
    const zaiMessages = messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role, content: m.content };
      }
      // Multimodal: extract text + image parts
      const content = m.content.map((p) => {
        if (p.type === "text" && typeof p.text === "string") {
          return { type: "text", text: p.text };
        }
        if (p.type === "image_url" && p.image_url?.url) {
          return { type: "image_url", image_url: { url: p.image_url.url } };
        }
        return null;
      }).filter(Boolean);
      return { role: m.role, content };
    });
    try {
      const completion = await withRetry(() =>
        zai.chat.completions.createVision({ messages: zaiMessages })
      );
      return (
        completion?.choices?.[0]?.message?.content ??
        "Sorry, I couldn't analyze the attached image(s). Please try again."
      );
    } catch (err: any) {
      // If vision isn't supported by the deployed Z.ai backend, downgrade to text-only
      console.warn("[llm/zai] vision failed, downgrading to text-only:", err?.message);
      const textOnly: ChatMessage[] = messages.map((m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const text = m.content
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("\n");
        return { role: m.role, content: text || "(no text provided)" };
      });
      const completion = await withRetry(() =>
        zai.chat.completions.create({ messages: toOpenAIMessages(textOnly) })
      );
      return (
        completion?.choices?.[0]?.message?.content ??
        "Sorry, I couldn't analyze the attached image(s). Please try again."
      );
    }
  }

  // DeepSeek branch — DeepSeek doesn't support vision, so we silently
  // downgrade to text-only by extracting just the text parts.
  if (provider === "deepseek") {
    try {
      const ds = getDeepSeekClient();
      const textOnly: ChatMessage[] = messages.map((m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const text = m.content
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("\n");
        return { role: m.role, content: text || "(no text provided)" };
      });
      console.warn("[llm] Vision request downgraded to text-only on DeepSeek");
      const completion = await withRetry(() =>
        ds.chat.completions.create({
          model: getLLMModel() ?? "deepseek-chat",
          messages: toOpenAIMessages(textOnly),
        })
      );
      deepSeekVerifiedWorking = true;
      return (
        completion.choices?.[0]?.message?.content ??
        "Sorry, I couldn't analyze the attached image(s). Please try again."
      );
    } catch (err: any) {
      if (err?.status === 401 || /401|authentication/i.test(err?.message ?? "")) {
        deepSeekVerifiedWorking = false;
        return visionComplete(messages, model);
      }
      throw err;
    }
  }

  // Gemini branch (default — full multimodal)
  const client = getClient();
  const { contents, systemInstruction } = toGeminiVisionContents(messages);
  const response = await withRetry(() =>
    client.models.generateContent({
      model,
      contents,
      config: systemInstruction ? { systemInstruction } : {},
    })
  );
  const text = response.text;
  return (
    text ??
    "Sorry, I couldn't analyze the attached image(s). Please try again."
  );
}

// ---------------------------------------------------------------------------
// Public API — streaming completions
// ---------------------------------------------------------------------------

/**
 * Parse one SSE chunk (Uint8Array or string) and return any new content
 * deltas found in it.
 *
 * NOTE: This class is no longer used by the streaming code paths below
 * (the @google/genai SDK yields structured chunks with a `.text` property,
 * not raw SSE bytes). It is kept for backwards compatibility with the
 * existing unit tests and any future code that might want to parse SSE.
 */
export class SSEParser {
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
    this.buffer = "";
    return this.feed(leftover + "\n");
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
  options?: { maxTokens?: number }
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const provider = await getProvider();

  // Z.ai GLM branch — final fallback, always available in this sandbox
  if (provider === "zai") {
    const zai = await getZaiClient();
    // The Z.ai SDK's `stream: true` returns an async iterator of raw SSE
    // bytes (Uint8Array), NOT parsed JSON chunks. We need to buffer the
    // bytes, split on newlines, and parse each `data: {...}` line.
    const stream = await withRetry(() =>
      zai.chat.completions.create({
        messages: toOpenAIMessages(messages),
        stream: true,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      })
    );
    return new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder();
        let sseBuffer = "";
        try {
          for await (const rawChunk of stream as any) {
            // rawChunk can be a Uint8Array (SSE bytes) OR a parsed object
            // (some Z.ai SDK versions yield objects). Handle both.
            let chunkStr: string;
            if (rawChunk instanceof Uint8Array) {
              chunkStr = decoder.decode(rawChunk, { stream: true });
            } else if (typeof rawChunk === "string") {
              chunkStr = rawChunk;
            } else if (rawChunk?.choices?.[0]?.delta?.content) {
              // Already-parsed object form
              controller.enqueue(
                encoder.encode(rawChunk.choices[0].delta.content)
              );
              continue;
            } else {
              continue;
            }
            sseBuffer += chunkStr;
            // Process complete SSE lines (terminated by \n)
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? ""; // keep the last partial line
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  controller.enqueue(encoder.encode(delta));
                }
              } catch {
                // Partial JSON across chunks — ignore, will be completed next iteration
              }
            }
          }
          // Flush any remaining buffer
          if (sseBuffer.trim().startsWith("data:")) {
            const payload = sseBuffer.trim().slice(5).trim();
            if (payload && payload !== "[DONE]") {
              try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  controller.enqueue(encoder.encode(delta));
                }
              } catch {
                /* ignore final partial */
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Stream interrupted";
          console.error("[llm/zai] mid-stream error:", msg);
          controller.enqueue(
            encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
          );
        } finally {
          controller.close();
        }
      },
    });
  }

  // DeepSeek branch — use the OpenAI SDK's stream: true and pipe deltas.
  if (provider === "deepseek") {
    try {
      const ds = getDeepSeekClient();
      const stream = await withRetry(() =>
        ds.chat.completions.create({
          model: getLLMModel() ?? "deepseek-chat",
          messages: toOpenAIMessages(messages),
          stream: true,
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        })
      );
      deepSeekVerifiedWorking = true;
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream as any) {
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                controller.enqueue(encoder.encode(delta));
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Stream interrupted";
            console.error("[llm/deepseek] mid-stream error:", msg);
            controller.enqueue(
              encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
            );
          } finally {
            controller.close();
          }
        },
      });
    } catch (err: any) {
      if (err?.status === 401 || /401|authentication/i.test(err?.message ?? "")) {
        console.warn("[llm] DeepSeek key rejected (401) on stream init. Falling back to Z.ai GLM.");
        deepSeekVerifiedWorking = false;
        return chatCompleteStream(messages, options);
      }
      throw err;
    }
  }

  // Gemini branch (default)
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
    })
  );

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const text = typeof chunk?.text === "string" ? chunk.text : "";
          if (text.length > 0) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (err) {
        // Mid-stream error — emit a notice and close. We can't retry here
        // without duplicating what we've already sent.
        const msg = err instanceof Error ? err.message : "Stream interrupted";
        console.error("[llm] mid-stream error:", msg);
        controller.enqueue(
          encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
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
  model: string = getLLMVisionModel()
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const provider = await getProvider();

  // Z.ai GLM branch — downgrade to text-only streaming (vision-streaming
  // isn't supported by the deployed Z.ai backend in this sandbox).
  if (provider === "zai") {
    const zai = await getZaiClient();
    const textOnly: ChatMessage[] = messages.map((m) => {
      if (typeof m.content === "string") return { role: m.role, content: m.content };
      const text = m.content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("\n");
      return { role: m.role, content: text || "(no text provided)" };
    });
    console.warn("[llm/zai] Vision stream downgraded to text-only");
    const stream = await withRetry(() =>
      zai.chat.completions.create({
        messages: toOpenAIMessages(textOnly),
        stream: true,
      })
    );
    return new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder();
        let sseBuffer = "";
        try {
          for await (const rawChunk of stream as any) {
            let chunkStr: string;
            if (rawChunk instanceof Uint8Array) {
              chunkStr = decoder.decode(rawChunk, { stream: true });
            } else if (typeof rawChunk === "string") {
              chunkStr = rawChunk;
            } else if (rawChunk?.choices?.[0]?.delta?.content) {
              controller.enqueue(
                encoder.encode(rawChunk.choices[0].delta.content)
              );
              continue;
            } else {
              continue;
            }
            sseBuffer += chunkStr;
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  controller.enqueue(encoder.encode(delta));
                }
              } catch {
                /* partial JSON */
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Stream interrupted";
          console.error("[llm/zai vision] mid-stream error:", msg);
          controller.enqueue(
            encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
          );
        } finally {
          controller.close();
        }
      },
    });
  }

  // DeepSeek branch — downgrade to text-only (DeepSeek doesn't support vision).
  if (provider === "deepseek") {
    try {
      const ds = getDeepSeekClient();
      const textOnly: ChatMessage[] = messages.map((m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const text = m.content
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("\n");
        return { role: m.role, content: text || "(no text provided)" };
      });
      console.warn("[llm] Vision stream downgraded to text-only on DeepSeek");
      const stream = await withRetry(() =>
        ds.chat.completions.create({
          model: getLLMModel() ?? "deepseek-chat",
          messages: toOpenAIMessages(textOnly),
          stream: true,
        })
      );
      deepSeekVerifiedWorking = true;
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream as any) {
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                controller.enqueue(encoder.encode(delta));
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Stream interrupted";
            console.error("[llm/deepseek vision] mid-stream error:", msg);
            controller.enqueue(
              encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
            );
          } finally {
            controller.close();
          }
        },
      });
    } catch (err: any) {
      if (err?.status === 401 || /401|authentication/i.test(err?.message ?? "")) {
        deepSeekVerifiedWorking = false;
        return visionCompleteStream(messages, model);
      }
      throw err;
    }
  }

  // Gemini branch (default — full multimodal)
  const client = getClient();
  const { contents, systemInstruction } = toGeminiVisionContents(messages);
  const stream = await withRetry(() =>
    client.models.generateContentStream({
      model,
      contents,
      config: systemInstruction ? { systemInstruction } : {},
    })
  );

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          const text = typeof chunk?.text === "string" ? chunk.text : "";
          if (text.length > 0) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream interrupted";
        console.error("[llm vision] mid-stream error:", msg);
        controller.enqueue(
          encoder.encode(`\n\n\u26a0\ufe0f _Stream interrupted: ${msg}_`)
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
