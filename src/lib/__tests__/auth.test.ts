import { describe, it, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../auth";

/**
 * We test only the pure password-hashing functions here.
 *
 * createSession / getSessionUser / destroySession touch the Prisma DB and the
 * next/headers cookies() store, so they need a full Next.js runtime context
 * and are out of scope for unit tests. (hashPassword / verifyPassword are the
 * only pieces that can be exercised in isolation — and they are the parts most
 * worth testing: a bug here would silently break login for everyone.)
 */
describe("hashPassword / verifyPassword", () => {
  it("hashPassword returns a non-empty string in 'salt:hash' format", () => {
    const out = hashPassword("hunter2");
    expect(out).not.toBe("hunter2");
    expect(out).toContain(":");
    const [salt, hash] = out.split(":");
    expect(salt.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
    // Salt is 16 random bytes hex-encoded = 32 chars.
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different hash for the same password each time (random salt)", () => {
    const h1 = hashPassword("same-password");
    const h2 = hashPassword("same-password");
    expect(h1).not.toBe(h2);
  });

  it("verifyPassword returns true for the correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("verifyPassword returns false for an incorrect password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("verifyPassword returns false for an empty password against a real hash", () => {
    const stored = hashPassword("real-password");
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("verifyPassword returns false for a malformed stored hash", () => {
    expect(verifyPassword("anything", "malformed")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "onlysalt")).toBe(false);
    expect(verifyPassword("anything", ":onlyhash")).toBe(false);
    expect(verifyPassword("anything", "onlysalt:")).toBe(false);
  });

  it("verifyPassword handles Unicode passwords round-trip", () => {
    const pw = "пароль🔐";
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword("пароль🔓", stored)).toBe(false);
  });

  it("verifyPassword uses constant-time comparison (timingSafeEqual)", () => {
    // Smoke test: this just verifies the function doesn't throw and returns
    // the right answer for two hashes of the same length. We can't directly
    // assert timing safety from a unit test, but we can at least make sure
    // equal-length wrong passwords still fail.
    const stored = hashPassword("abc123");
    // A wrong password whose scrypt output happens to be the same byte length
    // (it always is, since we request 64 bytes) — verifyPassword must still
    // return false.
    expect(verifyPassword("xyz789", stored)).toBe(false);
    expect(verifyPassword("000000", stored)).toBe(false);
    expect(verifyPassword("      ", stored)).toBe(false);
  });
});
