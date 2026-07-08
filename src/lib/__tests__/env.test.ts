import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// We test the validator logic indirectly by importing the module and
// stubbing process.env. The `assertEnvOrExit` function has side effects
// (console.warn/error, throw), so we capture and silence them.

describe("env validator (src/lib/env.ts)", () => {
  const originalEnv = { ...process.env };

  // Capture console output so tests don't spam the terminal.
  const warnSpy = mock(() => {});
  const errorSpy = mock(() => {});

  beforeEach(() => {
    // Minimal env: clear everything, then set just what we need.
    // NODE_ENV is typed read-only in @types/node, so we go through Object.assign
    // (runtime-writable) instead of direct assignment.
    for (const k of Object.keys(process.env)) delete (process.env as Record<string, string | undefined>)[k];
    Object.assign(process.env, { NODE_ENV: "development" });
    console.warn = warnSpy as any;
    console.error = errorSpy as any;
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    // Restore original env (Object.assign to bypass read-only NODE_ENV typing).
    for (const k of Object.keys(process.env)) delete (process.env as Record<string, string | undefined>)[k];
    Object.assign(process.env, originalEnv);
  });

  it("passes silently when all required env vars are set", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    process.env.GEMINI_API_KEY = "AIzaSyTest";
    const { assertEnvOrExit } = await import("../env");
    expect(() => assertEnvOrExit()).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts a SQLite file: URL", async () => {
    process.env.DATABASE_URL = "file:./db/custom.db";
    process.env.GEMINI_API_KEY = "AIzaSyTest";
    const { assertEnvOrExit } = await import("../env");
    expect(() => assertEnvOrExit()).not.toThrow();
  });

  it("throws in dev when GEMINI_API_KEY is missing", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    // GEMINI_API_KEY intentionally unset
    const { assertEnvOrExit } = await import("../env");
    expect(() => assertEnvOrExit()).toThrow(/GEMINI_API_KEY/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws in dev when DATABASE_URL is missing", async () => {
    process.env.GEMINI_API_KEY = "AIzaSyTest";
    // DATABASE_URL intentionally unset
    const { assertEnvOrExit } = await import("../env");
    expect(() => assertEnvOrExit()).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL has an invalid protocol", async () => {
    process.env.DATABASE_URL = "mysql://wrong://proto";
    process.env.GEMINI_API_KEY = "AIzaSyTest";
    const { assertEnvOrExit } = await import("../env");
    expect(() => assertEnvOrExit()).toThrow(/DATABASE_URL/);
  });

  it("warns (but does not throw) when SESSION_SECRET is empty in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    process.env.GEMINI_API_KEY = "AIzaSyTest";
    // SESSION_SECRET intentionally unset
    const { assertEnvOrExit } = await import("../env");
    // In production with all required vars set, the only issue is the
    // SESSION_SECRET warning — that's a warn, not a fatal, so it should
    // NOT throw (process.exit mock would throw if called).
    expect(() => assertEnvOrExit()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SESSION_SECRET")
    );
  });

  it("throws in production when GEMINI_API_KEY is missing", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    // GEMINI_API_KEY intentionally unset
    const { assertEnvOrExit } = await import("../env");
    // In production, missing env vars throw (which crashes the server boot
    // with a clear error — same fail-fast effect as process.exit, but
    // works in the Edge Runtime where process.exit is unavailable).
    expect(() => assertEnvOrExit()).toThrow(/GEMINI_API_KEY/);
  });
});
