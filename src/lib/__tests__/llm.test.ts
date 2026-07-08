import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isTransientError,
  withRetry,
  getLLMModel,
  getLLMVisionModel,
  SSEParser,
} from "../llm";

describe("isTransientError", () => {
  it("returns true for HTTP 429 (rate limit)", () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ statusCode: 429 })).toBe(true);
  });

  it("returns true for gateway errors 502/503/504/520/521/522/524", () => {
    for (const code of [502, 503, 504, 520, 521, 522, 524]) {
      expect(isTransientError({ status: code })).toBe(true);
    }
  });

  it("returns true for network-error messages", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("network error"))).toBe(true);
    expect(isTransientError(new Error("terminated"))).toBe(true);
    expect(isTransientError(new Error("aborted"))).toBe(true);
  });

  it("returns true for rate-limit messages without an explicit status", () => {
    expect(isTransientError(new Error("Too Many Requests"))).toBe(true);
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
    expect(isTransientError(new Error("Bad Gateway"))).toBe(true);
    expect(isTransientError(new Error("Gateway Timeout"))).toBe(true);
    expect(isTransientError(new Error("Service Unavailable"))).toBe(true);
    expect(isTransientError(new Error("upstream error"))).toBe(true);
  });

  it("returns false for client errors 400/401/403/422", () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 403 })).toBe(false);
    expect(isTransientError({ status: 422 })).toBe(false);
  });

  it("returns false for generic application errors", () => {
    expect(isTransientError(new Error("Invalid prompt"))).toBe(false);
    expect(isTransientError(new Error("User not found"))).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on transient errors and succeeds when the function eventually returns", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 2) {
        const e = new Error("429 Too Many Requests");
        (e as any).status = 429;
        throw e;
      }
      return "recovered";
    });
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("throws immediately on non-transient errors (no retry)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("400 Bad Request");
      })
    ).rejects.toThrow("400 Bad Request");
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts on persistent transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        const e = new Error("502 Bad Gateway");
        (e as any).status = 502;
        throw e;
      })
    ).rejects.toThrow();
    // Default maxAttempts is 3.
    expect(calls).toBe(3);
  });
});

describe("getLLMModel", () => {
  const original = process.env.LLM_MODEL;
  beforeEach(() => {
    delete process.env.LLM_MODEL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = original;
  });

  it("returns undefined when LLM_MODEL is unset", () => {
    expect(getLLMModel()).toBeUndefined();
  });

  it("returns undefined when LLM_MODEL is empty string", () => {
    process.env.LLM_MODEL = "";
    expect(getLLMModel()).toBeUndefined();
  });

  it("returns undefined when LLM_MODEL is whitespace-only", () => {
    process.env.LLM_MODEL = "   \t  ";
    expect(getLLMModel()).toBeUndefined();
  });

  it("returns the trimmed value when LLM_MODEL is set", () => {
    process.env.LLM_MODEL = "  gemini-2.5-pro  ";
    expect(getLLMModel()).toBe("gemini-2.5-pro");
  });
});

describe("getLLMVisionModel", () => {
  const original = process.env.LLM_VISION_MODEL;
  beforeEach(() => {
    delete process.env.LLM_VISION_MODEL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LLM_VISION_MODEL;
    else process.env.LLM_VISION_MODEL = original;
  });

  it("defaults to 'gemini-2.0-flash' when LLM_VISION_MODEL is unset", () => {
    expect(getLLMVisionModel()).toBe("gemini-2.0-flash");
  });

  it("defaults to 'gemini-2.0-flash' when LLM_VISION_MODEL is empty", () => {
    process.env.LLM_VISION_MODEL = "";
    expect(getLLMVisionModel()).toBe("gemini-2.0-flash");
  });

  it("returns the trimmed value when LLM_VISION_MODEL is set", () => {
    process.env.LLM_VISION_MODEL = "  gemini-2.5-pro  ";
    expect(getLLMVisionModel()).toBe("gemini-2.5-pro");
  });
});

describe("SSEParser", () => {
  it("extracts content deltas from complete data: lines", () => {
    const p = new SSEParser();
    const out = p.feed(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":", world"}}]}\n\n'
    );
    expect(out).toEqual(["Hello", ", world"]);
  });

  it("ignores non-data lines (e.g. comments and event: lines)", () => {
    const p = new SSEParser();
    const out = p.feed(
      ": heartbeat\n" +
        "event: ping\n" +
        'data: {"choices":[{"delta":{"content":"only"}}]}\n\n'
    );
    expect(out).toEqual(["only"]);
  });

  it("ignores the [DONE] sentinel", () => {
    const p = new SSEParser();
    const out = p.feed(
      'data: {"choices":[{"delta":{"content":"end"}}]}\n\n' +
        "data: [DONE]\n\n"
    );
    expect(out).toEqual(["end"]);
  });

  it("ignores deltas with no content field", () => {
    const p = new SSEParser();
    const out = p.feed(
      'data: {"choices":[{"delta":{}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"first"}}]}\n\n' +
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"second"}}]}\n\n'
    );
    expect(out).toEqual(["first", "second"]);
  });

  it("ignores empty deltas (empty string content)", () => {
    const p = new SSEParser();
    const out = p.feed(
      'data: {"choices":[{"delta":{"content":""}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'
    );
    expect(out).toEqual(["x"]);
  });

  it("buffers partial lines across multiple feed() calls", () => {
    const p = new SSEParser();
    // Split a single data: line across two feed() calls — the parser must
    // buffer the partial line and only emit once the full line is seen.
    const out1 = p.feed('data: {"choices":[{"delta":{"content":"par');
    expect(out1).toEqual([]);
    const out2 = p.feed('tial"}}]}\n\n');
    expect(out2).toEqual(["partial"]);
  });

  it("accepts string input as well as Uint8Array", () => {
    const p = new SSEParser();
    const enc = new TextEncoder();
    const out = p.feed(
      enc.encode(
        'data: {"choices":[{"delta":{"content":"bytes"}}]}\n\n'
      )
    );
    expect(out).toEqual(["bytes"]);
  });

  it("flush() returns nothing on a clean buffer", () => {
    const p = new SSEParser();
    p.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    expect(p.flush()).toEqual([]);
  });

  it("flush() parses any leftover buffered line", () => {
    const p = new SSEParser();
    p.feed('data: {"choices":[{"delta":{"content":"leftover"}}]}'); // no trailing newline
    expect(p.flush()).toEqual(["leftover"]);
  });

  it("ignores malformed JSON in a data: line", () => {
    const p = new SSEParser();
    const out = p.feed(
      "data: {not valid json}\n\n" +
        'data: {"choices":[{"delta":{"content":"after"}}]}\n\n'
    );
    expect(out).toEqual(["after"]);
  });
});
