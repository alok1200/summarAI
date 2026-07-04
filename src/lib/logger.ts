/**
 * Structured logger — JSON to stdout, one line per event.
 *
 * WHY JSON?
 *   In production, log aggregators (Datadog, CloudWatch, Loki, Elasticsearch)
 *   expect JSON. Plain-text logs require regex parsing; JSON logs can be
 *   queried with `level=error route=/api/chat userId=abc`.
 *
 * WHY stdout (not a file)?
 *   Container orchestrators (k8s, Docker, systemd) capture stdout. Writing
 *   to a file requires log rotation, disk management, and is generally more
 *   fragile. stdout is the twelve-factor way.
 *
 * LEVELS:
 *   - debug   — verbose diagnostics (off in production)
 *   - info    — normal operational events (request in, request out)
 *   - warn    — degraded behavior (rate limit hit, fallback used)
 *   - error   — failures that need operator attention
 *
 * USAGE:
 *   import { logger } from "@/lib/logger";
 *   logger.info("chat.request", { userId, messageCount });
 *   logger.error("chat.failed", { userId, error: err.message });
 *
 * In dev (NODE_ENV !== "production"), logs are pretty-printed for readability.
 * In prod, they're single-line JSON.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: LogLevel, event: string, payload?: Record<string, unknown>) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[getMinLevel()]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(payload ?? {}),
  };

  if (process.env.NODE_ENV === "production") {
    // Single-line JSON.
    const line = JSON.stringify(record);
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  } else {
    // Pretty-print in dev for readability.
    const prefix = `[${record.ts}] ${level.toUpperCase().padEnd(5)} ${event}`;
    if (payload && Object.keys(payload).length > 0) {
      const pretty = JSON.stringify(payload, null, 2)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n");
      console.log(`${prefix}\n${pretty}`);
    } else {
      console.log(prefix);
    }
  }
}

export const logger = {
  debug: (event: string, payload?: Record<string, unknown>) =>
    emit("debug", event, payload),
  info: (event: string, payload?: Record<string, unknown>) =>
    emit("info", event, payload),
  warn: (event: string, payload?: Record<string, unknown>) =>
    emit("warn", event, payload),
  error: (event: string, payload?: Record<string, unknown>) =>
    emit("error", event, payload),
};

/**
 * AsyncLocalStorage-style request context. We use a simpler approach:
 * a module-level singleton that the middleware sets per request.
 *
 * In Next.js, route handlers run in their own async context but the
 * middleware-set `x-request-id` header is the canonical correlation ID —
 * we read it from there.
 */
export function requestIdFromHeaders(
  headers: Headers | undefined
): string | undefined {
  if (!headers) return undefined;
  return headers.get("x-request-id") ?? undefined;
}
