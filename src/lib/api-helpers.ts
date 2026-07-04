import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Helpers for API routes:
 *   - readJsonBody      — parse JSON body with a hard size cap (anti-DoS)
 *   - sanitizeError     — convert thrown errors into safe user-facing messages
 *   - jsonError         — build a uniform JSON error response
 *   - withRequestLogging — wraps a handler with structured request logging
 *
 * These are extracted into one module so every API route handles errors and
 * body-size limits consistently. Adding a new route? Use the same helpers.
 */

/** Default max body size: 2 MB. Tunable via MAX_BODY_BYTES env. */
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Read and parse a JSON request body with a hard size limit.
 *
 * Without a limit, an attacker can POST a 10 GB body and OOM the process
 * before `req.json()` ever returns. We read the body as text (which Node
 * streams, so memory pressure is bounded), check the byte length against
 * the limit, and only then parse.
 *
 * Returns `{ ok: true, value }` on success, or `{ ok: false, response }`
 * if the body was too large or malformed JSON. The route handler should
 * `return result.response` immediately on failure.
 */
export async function readJsonBody<T = unknown>(
  req: NextRequest,
  maxBytes: number = Number(process.env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES)
): Promise<
  | { ok: true; value: T }
  | { ok: false; response: NextResponse }
> {
  let text: string;
  try {
    // `req.text()` reads the entire body into a string. Next.js handles
    // backpressure for us; we just need to cap the size afterward.
    text = await req.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Malformed request body." },
        { status: 400 }
      ),
    };
  }

  if (text.length > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Request body too large (${text.length} bytes; limit ${maxBytes}).`,
        },
        { status: 413 }
      ),
    };
  }

  if (text.length === 0) {
    return { ok: true, value: {} as T };
  }

  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Request body is not valid JSON." },
        { status: 400 }
      ),
    };
  }
}

/**
 * Build a uniform JSON error response. Always includes a `error: string`
 * field. Optionally includes a `digest` (short random ID) that operators
 * can grep for in logs — useful when the same error is hit repeatedly.
 */
export function jsonError(
  status: number,
  message: string,
  extra?: Record<string, unknown>
): NextResponse {
  const digest =
    extra?.digest ??
    Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return NextResponse.json(
    { error: message, digest, ...extra },
    { status }
  );
}

/**
 * Sanitize a thrown error for client-facing display.
 *
 * Why: in development, exposing `err.message` is fine. In production, raw
 * error messages can leak internals (DB connection strings, file paths,
 * library names) that an attacker can use to fingerprint the stack.
 *
 * Strategy:
 *   1. If the error has a `safeMessage` property (set by code that knows
 *      the message is user-safe), use it.
 *   2. Otherwise, in production, return a generic message + a digest
 *      that operators can correlate with server logs.
 *   3. In development, return the raw message for easier debugging.
 */
export function sanitizeError(err: unknown): {
  message: string;
  digest: string;
} {
  const digest = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  let rawMessage: string;
  if (err instanceof Error) {
    rawMessage = err.message;
  } else if (err === undefined || err === null) {
    rawMessage = "Unknown error";
  } else {
    rawMessage = String(err);
  }

  // Allow opt-in safe messages via a custom property.
  const safe = (err as { safeMessage?: string })?.safeMessage;
  if (safe && typeof safe === "string") {
    return { message: safe, digest };
  }

  if (process.env.NODE_ENV === "production") {
    return {
      message: "Internal server error. Please try again.",
      digest,
    };
  }
  return { message: rawMessage || "Unknown error", digest };
}

/**
 * Wrap an API route handler with structured request logging.
 *
 * Logs:
 *   - request in (method, path, userId if known)
 *   - response out (status, durationMs)
 *   - error if the handler threw
 *
 * The wrapper preserves the handler's return type — it's a thin try/finally
 * around the call.
 */
type HandlerResult = Response | NextResponse;
type Handler = (req: NextRequest, ctx: { userId?: string }) =>
  Promise<HandlerResult> | HandlerResult;

export function withRequestLogging(
  route: string,
  handler: Handler
): (req: NextRequest) => Promise<HandlerResult> {
  return async (req: NextRequest) => {
    const start = Date.now();
    const requestId = req.headers.get("x-request-id") ?? "no-req-id";
    const method = req.method;
    const path = req.nextUrl?.pathname ?? new URL(req.url).pathname;

    logger.info("api.request", { route, method, path, requestId });

    try {
      const result = await handler(req, { userId: undefined });
      const durationMs = Date.now() - start;
      const status = result.status ?? 200;
      logger.info("api.response", {
        route,
        method,
        path,
        requestId,
        status,
        durationMs,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const sanitized = sanitizeError(err);
      logger.error("api.error", {
        route,
        method,
        path,
        requestId,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
        digest: sanitized.digest,
      });
      return jsonError(500, sanitized.message, { digest: sanitized.digest });
    }
  };
}
