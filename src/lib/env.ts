/**
 * Startup-time environment validation.
 *
 * This module is imported by `instrumentation.ts` (Next.js's official
 * startup hook) ONCE when the server boots — before any request is served.
 *
 * Why fail fast: if a critical env var is missing, the app will silently
 * 500 on every LLM/DB call. It's far better to refuse to start and print
 * a clear, actionable error message at boot, so the operator notices
 * immediately (e.g. in the systemd / Docker / Vercel logs) and can fix
 * the env before users hit the broken app.
 *
 * Validated vars:
 *   - DATABASE_URL        — must be a non-empty `postgresql://` or `file:` URL
 *   - GEMINI_API_KEY      — must be a non-empty string (no format check;
 *                            Google will 400 on first call if it's malformed)
 *
 * Warned (not fatal) vars:
 *   - SESSION_SECRET      — if empty, log a warning that sessions won't
 *                            survive a restart (random per-process fallback).
 *
 * NOT validated here (optional / has working defaults):
 *   - YOUTUBE_API_KEY, YOUTUBE_PROXY_URL, GOOGLE_CLIENT_*, NEXT_PUBLIC_APP_URL
 */

type EnvIssue = {
  level: "fatal" | "warn";
  varName: string;
  message: string;
};

function validateEnv(): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProd = nodeEnv === "production";

  // ----- DATABASE_URL (required) -----
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.trim()) {
    issues.push({
      level: "fatal",
      varName: "DATABASE_URL",
      message:
        "DATABASE_URL is not set. Set it in .env to a Postgres connection string " +
        "(e.g. postgresql://user:pass@host:5432/dbname?sslmode=require) or a SQLite " +
        "path (file:./db/custom.db).",
    });
  } else if (
    !dbUrl.startsWith("postgresql://") &&
    !dbUrl.startsWith("postgres://") &&
    !dbUrl.startsWith("file:")
  ) {
    issues.push({
      level: "fatal",
      varName: "DATABASE_URL",
      message: `DATABASE_URL must start with "postgresql://", "postgres://", or "file:" (got "${dbUrl.slice(
        0,
        30
      )}…").`,
    });
  }

  // ----- GEMINI_API_KEY (required) -----
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  if (!geminiKey.trim()) {
    issues.push({
      level: "fatal",
      varName: "GEMINI_API_KEY",
      message:
        "GEMINI_API_KEY is not set. Chat / summary / interview / vision routes " +
        "will 500. Get a free key at https://aistudio.google.com/apikey and add " +
        'it to .env as GEMINI_API_KEY="your-key".',
    });
  }

  // ----- SESSION_SECRET (warn in prod if empty) -----
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (!sessionSecret.trim() && isProd) {
    issues.push({
      level: "warn",
      varName: "SESSION_SECRET",
      message:
        "SESSION_SECRET is not set in production. Sessions will be invalidated " +
        "on every server restart. Generate one with `openssl rand -hex 32` and " +
        'add it to .env as SESSION_SECRET="<64-char-hex>"',
    });
  }

  return issues;
}

/**
 * Run env validation at startup. Logs warnings and throws on fatal errors.
 *
 * Called from `instrumentation.ts` (Next.js startup hook). Should NEVER
 * be called per-request — it's a one-shot boot check.
 */
export function assertEnvOrExit(): void {
  const issues = validateEnv();
  const fatals = issues.filter((i) => i.level === "fatal");
  const warnings = issues.filter((i) => i.level === "warn");

  for (const w of warnings) {
    console.warn(`[env] WARNING: ${w.varName}: ${w.message}`);
  }

  if (fatals.length > 0) {
    console.error("\n[env] FATAL: Required environment variables are missing or invalid.");
    for (const f of fatals) {
      console.error(`[env]   • ${f.varName}: ${f.message}`);
    }
    console.error("\n[env] Refusing to start. Fix the above and restart.\n");
    // In development, throw (so the dev server shows a clear error in the
    // browser / terminal). In production, exit non-zero so the process
    // manager (systemd / Docker / Vercel) restarts the container.
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    } else {
      throw new Error(
        `FATAL: ${fatals.map((f) => f.varName).join(", ")} env var(s) missing or invalid. ` +
          "See server logs above."
      );
    }
  }
}
