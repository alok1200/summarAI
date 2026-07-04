import { describe, it, expect } from "bun:test";
import { logger, requestIdFromHeaders } from "@/lib/logger";

describe("logger", () => {
  it("exposes all four log levels", () => {
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("does not throw on any call", () => {
    // Smoke test — just make sure none of these crash.
    expect(() => logger.debug("test.debug", { foo: 1 })).not.toThrow();
    expect(() => logger.info("test.info", { foo: 1 })).not.toThrow();
    expect(() => logger.warn("test.warn", { foo: 1 })).not.toThrow();
    expect(() => logger.error("test.error", { foo: 1 })).not.toThrow();
    expect(() => logger.info("test.no-payload")).not.toThrow();
  });

  it("accepts arbitrary payload shapes", () => {
    expect(() =>
      logger.info("test.complex", {
        string: "x",
        number: 42,
        nested: { a: [1, 2, 3] },
        null: null,
        undef: undefined,
      })
    ).not.toThrow();
  });
});

describe("requestIdFromHeaders", () => {
  it("reads x-request-id from a Headers object", () => {
    const h = new Headers({ "x-request-id": "abc12345" });
    expect(requestIdFromHeaders(h)).toBe("abc12345");
  });

  it("returns undefined when header is missing", () => {
    const h = new Headers();
    expect(requestIdFromHeaders(h)).toBeUndefined();
  });

  it("returns undefined when called with undefined", () => {
    expect(requestIdFromHeaders(undefined)).toBeUndefined();
  });
});
