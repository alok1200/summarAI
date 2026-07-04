import { describe, it, expect, beforeEach } from "bun:test";
import {
  readJsonBody,
  sanitizeError,
  jsonError,
} from "@/lib/api-helpers";
import { NextRequest } from "next/server";

/**
 * Helper: set NODE_ENV in a way that satisfies the strict bun-types
 * declaration of `process.env.NODE_ENV` (which is read-only).
 */
function setNodeEnv(value: string) {
  (process.env as { NODE_ENV?: string }).NODE_ENV = value;
}
function resetNodeEnv() {
  delete (process.env as { NODE_ENV?: string }).NODE_ENV;
}

/**
 * Build a NextRequest with a JSON body for testing.
 */
function makeReq(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: text,
  });
}

describe("readJsonBody", () => {
  it("parses valid JSON", async () => {
    const req = makeReq({ foo: "bar", n: 42 });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ foo: "bar", n: 42 });
    }
  });

  it("returns 400 on malformed JSON", async () => {
    const req = makeReq("{not valid json");
    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns 413 when body exceeds maxBytes", async () => {
    const req = makeReq({ big: "x".repeat(5000) });
    const result = await readJsonBody(req, 100); // 100-byte limit
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
    }
  });

  it("returns ok with empty object when body is empty", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it("respects custom maxBytes", async () => {
    const req = makeReq({ ok: "small" });
    // 1-byte limit — even this tiny JSON is too big.
    const result = await readJsonBody(req, 1);
    expect(result.ok).toBe(false);
  });

  it("accepts a generic type parameter", async () => {
    interface Foo {
      a: string;
      b: number;
    }
    const req = makeReq({ a: "hello", b: 7 });
    const result = await readJsonBody<Foo>(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.a).toBe("hello");
      expect(result.value.b).toBe(7);
    }
  });
});

describe("sanitizeError", () => {
  beforeEach(() => {
    resetNodeEnv();
  });

  it("returns the raw message in development", () => {
    setNodeEnv("development");
    const err = new Error("DB connection refused at postgres://user:pass@host:5432");
    const out = sanitizeError(err);
    expect(out.message).toContain("DB connection refused");
    expect(out.message).toContain("postgres://user:pass@host:5432");
    expect(out.digest).toMatch(/^[a-z0-9]{8}$/);
  });

  it("returns a generic message in production (no leaked internals)", () => {
    setNodeEnv("production");
    const err = new Error("DB connection refused at postgres://user:pass@host:5432");
    const out = sanitizeError(err);
    expect(out.message).toBe("Internal server error. Please try again.");
    // The sensitive URL must NOT appear in the sanitized message.
    expect(out.message).not.toContain("postgres://");
    expect(out.digest).toMatch(/^[a-z0-9]{8}$/);
  });

  it("uses safeMessage when present (even in production)", () => {
    setNodeEnv("production");
    const err = Object.assign(new Error("internal stack trace leak"), {
      safeMessage: "User-friendly explanation here",
    });
    const out = sanitizeError(err);
    expect(out.message).toBe("User-friendly explanation here");
  });

  it("handles non-Error thrown values", () => {
    setNodeEnv("development");
    const out = sanitizeError("just a string");
    expect(out.message).toBe("just a string");
    expect(out.digest).toMatch(/^[a-z0-9]{8}$/);
  });

  it("handles null/undefined", () => {
    setNodeEnv("development");
    const out = sanitizeError(undefined);
    expect(out.message).toBe("Unknown error");
  });

  it("generates a different digest for different errors (high probability)", () => {
    setNodeEnv("production");
    const d1 = sanitizeError(new Error("err1")).digest;
    const d2 = sanitizeError(new Error("err2")).digest;
    // 8-char base36 = ~41 bits of entropy; collision probability for two
    // samples is ~1e-12, so this is safe to assert.
    expect(d1).not.toBe(d2);
  });
});

describe("jsonError", () => {
  it("includes the message and a digest", async () => {
    const res = jsonError(500, "something broke");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("something broke");
    expect(body.digest).toMatch(/^[a-z0-9]{8}$/);
  });

  it("preserves caller-supplied digest", async () => {
    const res = jsonError(400, "bad input", { digest: "custom123" });
    const body = await res.json();
    expect(body.digest).toBe("custom123");
  });

  it("passes through extra fields", async () => {
    const res = jsonError(403, "blocked", { code: "BOT_BLOCKED", videoId: "abc" });
    const body = await res.json();
    expect(body.code).toBe("BOT_BLOCKED");
    expect(body.videoId).toBe("abc");
  });
});
